import { createHash } from "node:crypto";
import { prepareNativeSessionGenerationAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { z } from "zod";
import { CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { buildCodexAppServerRuntimeFingerprint } from "./app-server/plugin-app-cache-key.js";
import {
  bindingStoreKey,
  readStoredCodexAppServerBinding,
} from "./app-server/session-binding-record.js";
import type {
  CodexAppServerBindingStore,
  CodexBindingStateStore,
} from "./app-server/session-binding.js";
import { withCodexAppServerThreadMutation } from "./app-server/thread-ownership-queue.js";
import { releaseCodexAppServerBindingSubscription } from "./app-server/thread-ownership.js";
import { listCodexUpstreamTurns } from "./app-server/upstream-fork-boundary.js";

type BindingReads = Pick<CodexBindingStateStore, "lookup" | "entries">;
const inspectParams = z
  .object({
    sessionKey: z
      .string()
      .regex(/^agent:main:slack:direct:(?:team:t[a-z0-9]+:user:)?[uw][a-z0-9]+$/),
  })
  .strict();
const resetParams = inspectParams.extend({ incidentId: z.string().regex(/^[0-9a-f]{64}$/) });
const endpointFingerprint = z.object({ endpoint: z.string() });

function readSession(config: OpenClawConfig, sessionKey: string) {
  return getSessionEntry({
    agentId: "main",
    sessionKey,
    storePath: resolveStorePath(config.session?.store, { agentId: "main" }),
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
}

function readIncident(
  config: OpenClawConfig,
  sessionKey: string,
  bindings: BindingReads,
  leased = false,
) {
  const session = readSession(config, sessionKey);
  if (!session || session.archivedAt) {
    return { state: "unaffected" } as const;
  }
  const identity = { kind: "session", agentId: "main", sessionId: session.sessionId } as const;
  const key = bindingStoreKey({ ...identity, sessionKey });
  const readRow = (storageKey: string) => {
    const raw = bindings.lookup(storageKey);
    if (raw === undefined) {
      return undefined;
    }
    const row = readStoredCodexAppServerBinding(raw);
    if (!row) {
      throw new Error("Invalid Codex binding");
    }
    return row.state === "active" ? row : undefined;
  };
  // A physical session ID may be shared by multiple logical DM rows. A physical-only
  // binding has no evidence that this particular Slack owner can detach its thread.
  if (readRow(bindingStoreKey(identity))) {
    return { state: "unavailable" } as const;
  }
  const row = readRow(key);
  if (!row) {
    return { state: "unaffected" } as const;
  }
  if (row.sessionId !== session.sessionId) {
    return { state: "unavailable" } as const;
  }
  const binding = row.binding;
  const receipt = binding.turnRecovery;
  if (!receipt) {
    return { state: "unaffected" } as const;
  }
  if (!leased && row.lease && row.lease.expiresAt > Date.now()) {
    return { state: "busy" } as const;
  }
  if (
    receipt.state !== "settling" ||
    row.nativeSubagentAssignments !== undefined ||
    row.nativeSubagentSubmissions !== undefined ||
    binding.connectionScope ||
    binding.preserveNativeModel ||
    binding.pendingResumeConfiguration ||
    binding.contextEngine ||
    binding.ringZeroClientInstanceId ||
    binding.ringZeroConfigFingerprint
  ) {
    return { state: "unavailable" } as const;
  }
  // Alias owners can share a physical session or a native thread. Never reset one by guessing.
  if (
    bindings
      .entries()
      .some(
        (other) =>
          other.key !== key &&
          other.value.state === "active" &&
          (other.value.sessionId === session.sessionId ||
            other.value.binding.threadId === binding.threadId),
      )
  ) {
    return { state: "unavailable" } as const;
  }
  const appServer = resolveCodexAppServerRuntimeOptions({
    config,
    pluginConfig: config.plugins?.entries?.codex?.config,
    agentDir: resolveAgentDir(config, "main"),
  });
  const { start } = appServer;
  // Only connect using configured credentials. A binding is evidence of ownership, never a destination.
  if (
    start.transport !== "websocket" ||
    !start.url ||
    !binding.appServerRuntimeFingerprint ||
    endpointFingerprint.parse(JSON.parse(binding.appServerRuntimeFingerprint)).endpoint !==
      endpointFingerprint.parse(JSON.parse(buildCodexAppServerRuntimeFingerprint({ appServer })))
        .endpoint
  ) {
    return { state: "unavailable" } as const;
  }
  const incidentId = createHash("sha256")
    .update(
      JSON.stringify([
        sessionKey,
        key,
        session.sessionId,
        session.lifecycleRevision ?? null,
        session.updatedAt,
        session.sessionStartedAt ?? null,
        binding,
      ]),
    )
    .digest("hex");
  return {
    state: "candidate",
    binding,
    identity: { ...identity, sessionKey },
    session,
    threadId: binding.threadId,
    turnId: receipt.turnId,
    start,
    incidentId,
  } as const;
}

class IncidentChanged extends Error {}

type Incident = Extract<ReturnType<typeof readIncident>, { state: "candidate" }>;

async function nativeState(incident: Incident, assertCurrent: () => void, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20_000);
  const scope = signal ? AbortSignal.any([signal, timeout]) : timeout;
  assertCurrent();
  const client = await CodexAppServerClient.start(incident.start, assertCurrent);
  const close = () => client.close();
  scope.addEventListener("abort", close, { once: true });
  try {
    scope.throwIfAborted();
    await client.initialize();
    const options = { signal: scope, assertCurrent };
    const threadId = incident.threadId;
    const turns = await listCodexUpstreamTurns(
      {
        listTurnPage: (request) => client.request("thread/turns/list", request, options),
      },
      threadId,
      "notLoaded",
    );
    if (turns.some((turn) => turn.status === "inProgress")) {
      return "busy";
    }
    const latest = turns.at(-1);
    if (
      latest?.id !== incident.turnId ||
      latest.status !== "interrupted" ||
      turns.some((turn) => !["completed", "interrupted", "failed"].includes(turn.status ?? ""))
    ) {
      return "unavailable";
    }
    const { thread } = await client.request(
      "thread/read",
      { threadId, includeTurns: false },
      options,
    );
    if (thread.id !== threadId) {
      return "unavailable";
    }
    switch (thread.status?.type) {
      case "active":
        return "busy";
      case "notLoaded":
      case "idle":
        return "interrupted";
      default:
        return "unavailable";
    }
  } finally {
    scope.removeEventListener("abort", close);
    close();
  }
}

export async function handleOwnerDmRecovery(
  action: "inspect" | "reset",
  {
    params,
    respond,
    client,
    context,
    signal,
    hasCurrentClientAuthority,
  }: GatewayRequestHandlerOptions,
  bindings: BindingReads,
  store: CodexAppServerBindingStore,
) {
  const pluginId = client?.internal?.pluginRuntimeOwnerId;
  if (!client || (pluginId && pluginId !== "claw-gateway-plugin")) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "This caller cannot manage an owner DM."),
    );
    return;
  }
  const parsed = (action === "inspect" ? inspectParams : resetParams).safeParse(params);
  if (!parsed.success) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Expected a main Slack owner DM and valid recovery parameters.",
      ),
    );
    return;
  }
  const config = context.getRuntimeConfig();
  const assertCurrent = () => {
    if (
      signal?.aborted ||
      hasCurrentClientAuthority?.() === false ||
      context.getRuntimeConfig() !== config
    ) {
      throw new Error("Request no longer current");
    }
  };
  const { sessionKey } = parsed.data;
  try {
    assertCurrent();
    const inspect = () => readIncident(config, sessionKey, bindings);
    const incident = inspect();
    if (action === "reset" && incident.state === "unavailable") {
      throw new Error("Cannot establish current owner");
    }
    if (incident.state !== "candidate") {
      respond(true, { state: action === "inspect" ? incident.state : "changed" });
      return;
    }
    if (action === "reset" && incident.incidentId !== params.incidentId) {
      respond(true, { state: "changed" });
      return;
    }
    if (action === "inspect") {
      const state = await nativeState(incident, assertCurrent, signal);
      assertCurrent();
      const current = inspect();
      if (current.state !== "candidate" || current.incidentId !== incident.incidentId) {
        respond(true, { state: "unavailable" });
      } else {
        respond(
          true,
          state === "interrupted" ? { state, incidentId: incident.incidentId } : { state },
        );
      }
      return;
    }
    const assertSessionCurrent = () => {
      assertCurrent();
      const current = readSession(config, sessionKey);
      if (
        current?.sessionId !== incident.session.sessionId ||
        current.lifecycleRevision !== incident.session.lifecycleRevision ||
        current.updatedAt !== incident.session.updatedAt
      ) {
        throw new IncidentChanged();
      }
    };
    const { state: generation, authority } = await prepareNativeSessionGenerationAuthority({
      config,
      target: incident.identity,
      assertCurrent: assertSessionCurrent,
      createSupersededError: () => new IncidentChanged(),
    });
    if (generation !== "current") {
      throw new IncidentChanged();
    }
    // Normal admission takes this native-thread lock and then the host binding lease.
    // While both are held, no other Gateway turn can adopt or replace our snapshot.
    const detached = await withCodexAppServerThreadMutation(incident.threadId, () =>
      store.withLease(
        incident.identity,
        async () => {
          assertSessionCurrent();
          const current = readIncident(config, sessionKey, bindings, true);
          if (current.state !== "candidate" || current.incidentId !== incident.incidentId) {
            return false;
          }
          const state = await nativeState(incident, assertSessionCurrent, signal);
          if (state === "busy") {
            return false;
          }
          if (state !== "interrupted") {
            throw new Error("Native owner unavailable");
          }
          await releaseCodexAppServerBindingSubscription(incident.binding, {
            assertCurrent: assertSessionCurrent,
            withCurrent: authority.withCurrent,
          });
          assertSessionCurrent();
          return await store.mutate(
            incident.identity,
            { kind: "clear", expectedBinding: incident.binding },
            assertSessionCurrent,
            authority,
          );
        },
        { assertCurrent: assertSessionCurrent, authority },
      ),
    );
    if (!detached) {
      throw new IncidentChanged();
    }
    assertCurrent();
    if (
      bindings
        .entries()
        .some(
          ({ value }) => value.state === "active" && value.binding.threadId === incident.threadId,
        ) ||
      (await nativeState(incident, assertCurrent, signal)) !== "interrupted"
    ) {
      throw new Error("Detachment unverified");
    }
    assertCurrent();
    respond(true, { state: "reset" });
  } catch (error) {
    if (error instanceof IncidentChanged) {
      respond(true, { state: "changed" });
    } else if (action === "inspect") {
      respond(true, { state: "unavailable" });
    } else {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Recovery could not be verified. Check the current status before retrying.",
        ),
      );
    }
  }
}
