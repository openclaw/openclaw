import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindScheduledExecutionContext } from "../cron/execution-context-registry.js";
import type { ScheduledExecutionContext } from "../cron/scheduled-occurrence.js";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import { resolveGatewayRequesterToolPolicies } from "../gateway/tool-resolution-authority.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { resolvePluginHarnessToolPolicies } from "./harness/execution-environment.js";
import type { RequesterOrigin } from "./requester-origin.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { resolveSenderRestrictedSpawnError } from "./spawn-requester-policy.js";
import {
  prepareSessionCapabilityRead,
  withPreparedSessionCapabilityRead,
  type SessionCapabilitySnapshot,
} from "./subagents/spawn/subagent-session-store.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

describe("resolveRequesterToolPolicies", () => {
  const requester = "agent:main:discord:direct:alice";
  const runtimeDeny = { deny: ["group:runtime", "group:fs"] };
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-requester-policy-");
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  async function writeSession(sessionKey: string, patch: Partial<SessionEntry>) {
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: `${sessionKey}-session`,
      updatedAt: Date.now(),
      ...patch,
    } as SessionEntry);
  }

  function config(overrides: OpenClawConfig = {}): OpenClawConfig {
    return {
      ...overrides,
      session: { ...overrides.session, store: storePath },
      tools: {
        ...overrides.tools,
        toolsBySender: {
          "*": { deny: ["group:runtime", "group:fs"] },
          "id:alice": {},
          ...overrides.tools?.toolsBySender,
        },
      },
    };
  }

  function resolvePolicy(params: Parameters<typeof resolveRequesterToolPolicies>[0]) {
    return withPreparedSessionCapabilityRead(() =>
      resolveRequesterToolPolicies({ config: config(), agentId: "main", ...params }),
    );
  }

  function writeChild(sessionKey: string, patch: Partial<SessionEntry> = {}) {
    return writeSession(sessionKey, {
      spawnedBy: requester,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      ...patch,
    });
  }

  function expectCurrentPolicy(result: ReturnType<typeof resolveRequesterToolPolicies>) {
    expectCurrentSource(result);
    expect(result.senderPolicy).toEqual(runtimeDeny);
  }

  function expectCurrentSource(result: ReturnType<typeof resolveRequesterToolPolicies>) {
    expect(result).toMatchObject({ delegated: false, requesterPolicySource: "current-request" });
  }

  function workerConfig(overrides: OpenClawConfig = {}) {
    return config({
      agents: {
        entries: {
          front: { subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] } },
          worker: {},
        },
      },
      ...overrides,
    });
  }

  function expectInherited(
    result: ReturnType<typeof resolveRequesterToolPolicies>,
    source: "persisted-child" | "completion-handoff",
    policy: { allow?: string[]; deny?: string[] },
  ) {
    expect(result).toMatchObject({ delegated: true, requesterPolicySource: source });
    expect(result.inheritedToolPolicy).toEqual(policy);
  }

  it("retains dashboard delegation and revocation fallback without an injected capability store", async () => {
    const root = "agent:front:main";
    const visible = "agent:worker:dashboard:coding";
    const helper = "agent:worker:subagent:helper";
    const cfg = workerConfig({
      tools: { toolsBySender: { "*": {} } },
    });
    const delegatedToolPolicy = {
      requesterSessionKey: root,
      targetAgentId: "worker",
      deny: [],
      requesterDeny: ["exec"],
    };
    const visibleEntry: SessionEntry = {
      sessionId: `${visible}-session`,
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: root,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
      delegatedToolPolicy,
    };
    await writeSession(visible, visibleEntry);
    await writeSession(helper, {
      spawnDepth: 2,
      spawnedBy: visible,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
      delegatedToolPolicy: { ...delegatedToolPolicy, requesterDeny: [] },
    });
    const resolve = () =>
      resolveRequesterToolPolicies({
        config: cfg,
        sessionKey: visible,
        preparedSessionEntry: { sessionKey: visible, entry: visibleEntry },
        ...completionHandoffFacts(helper, visible),
      });
    const resolved = await withPreparedSessionCapabilityRead(resolve);
    expect(resolved.delegatedToolPolicy).toMatchObject({
      requesterSessionKey: root,
      targetAgentId: "worker",
    });
    expect(resolved.inheritedToolPolicy?.deny ?? []).not.toContain("exec");
    const harness = await withPreparedSessionCapabilityRead(() =>
      resolvePluginHarnessToolPolicies(
        {
          config: cfg,
          agentId: "worker",
          sessionKey: visible,
          preparedSessionEntry: visibleEntry,
          provider: "fixture",
          modelId: "fixture",
        },
        resolved.subagentPolicy?.deny,
      ),
    );
    expect(harness.toolPolicyRestricted).toBe(true);
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect((await withPreparedSessionCapabilityRead(resolve)).inheritedToolPolicy?.deny).toContain(
      "exec",
    );
  });

  function completionHandoffFacts(sourceSessionKey: string, targetSessionKey: string) {
    const targetSessionId = `${targetSessionKey}-session`;
    return {
      trustedInternalHandoff: {
        kind: "subagent-completion" as const,
        sourceSessionKey,
        targetSessionKey,
        targetSessionId,
        provider: "openai",
        model: "gpt-test",
      },
      sessionId: targetSessionId,
      modelProvider: "openai",
      modelId: "gpt-test",
      inputProvenance: {
        kind: "inter_session" as const,
        sourceSessionKey,
        sourceTool: "subagent_announce",
      },
    };
  }

  it.each([true, false])(
    "scopes inherited completion policy without changing the child (restricted: %s)",
    async (restricted) => {
      const parent = "agent:main:main";
      const child = "agent:main:subagent:completion";
      const cfg = config({ tools: { toolsBySender: { "*": {} } } });
      await writeChild(child, { spawnedBy: parent, inheritedToolDeny: restricted ? ["exec"] : [] });
      const handoff = completionHandoffFacts(child, parent);
      const resolve = (sessionKey: string, completion = false) =>
        withPreparedSessionCapabilityRead(() =>
          resolvePluginHarnessToolPolicies({
            config: cfg,
            agentId: "main",
            sessionKey,
            preparedSessionEntry: null,
            provider: "openai",
            modelId: "gpt-test",
            ...(completion ? handoff : {}),
          }),
        );

      const owner = await resolve(parent);
      const completion = await resolve(parent, true);
      const resumedOwner = await resolve(parent);
      expect(owner).toMatchObject({ toolPolicyRestricted: false, toolPolicyScope: "conversation" });
      if (restricted) {
        expect(completion.runtimePolicies).toContainEqual({ deny: ["exec"] });
      }
      expect(completion).toMatchObject({
        toolPolicyRestricted: restricted,
        toolPolicyScope: restricted ? "turn" : "conversation",
      });
      expect(resumedOwner).toEqual(owner);
      expect(await resolve(child)).toMatchObject({
        toolPolicyRestricted: true,
        toolPolicyScope: "conversation",
      });
    },
  );

  it("classifies sender/channel restriction provenance", () => {
    const policy = { allow: ["read", "sessions_spawn"] };
    for (const source of ["sender", "conversation"] as const) {
      const result = resolveRequesterToolPolicies({
        config: config({
          tools: {
            allow: ["read", "sessions_spawn"],
            toolsBySender: { "id:alice": source === "sender" ? policy : {} },
          },
        }),
        sessionKey: requester,
        senderId: "alice",
        ...(source === "conversation" ? { conversationPolicy: policy } : {}),
      });
      expect(result.inheritedToolPolicySource).toBe("sender");
    }
  });

  it.each([
    "current",
    "revoked",
    "stale requester",
    "external sender",
    "different allow",
    "different deny",
    "different source",
    "missing lineage",
  ])("resolves a settled batch with %s authority", async (authority) => {
    const targetSessionKey = "agent:main:main";
    const sourceSessionKeys = ["agent:main:subagent:first", "agent:main:subagent:second"] as const;
    for (const [index, sessionKey] of sourceSessionKeys.entries()) {
      await writeSession(sessionKey, {
        spawnedBy: targetSessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: index === 1 && authority === "missing lineage" ? undefined : 1,
        inheritedToolAllow:
          index === 0
            ? ["read", "exec"]
            : authority === "different allow"
              ? ["read"]
              : ["exec", "read"],
        inheritedToolDeny:
          index === 1 && authority === "different deny" ? ["exec", "write"] : ["write"],
        inheritedToolPolicySource:
          index === 1 && authority === "different source" ? undefined : "sender",
      });
    }
    let current = true;
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey,
      targetSessionId: "requester-session",
      idempotencyKey: "settled-batch",
      settleBatch: { sourceSessionKeys, isCurrent: () => current },
    };
    const consumption = {
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      provider: "openai",
      model: "gpt-test",
    };
    const trustedInternalHandoff = consumeSubagentCompletionToolHandoff(consumption);
    current = authority !== "revoked";
    const request = {
      config: config(),
      sessionKey: targetSessionKey,
      sessionId:
        authority === "stale requester" ? "replacement-session" : registration.targetSessionId,
      ...(authority === "external sender" ? { senderId: "mallory" } : {}),
      modelProvider: consumption.provider,
      modelId: consumption.model,
      inputProvenance: {
        kind:
          authority === "external sender" ? ("external_user" as const) : ("inter_session" as const),
        sourceTool: "subagent_settle",
        sourceSessionKey: registration.sourceSessionKey,
      },
      trustedInternalHandoff,
    };
    const result = await resolvePolicy(request);
    if (authority !== "current") {
      expect(result.delegated).toBe(false);
      expect(result.senderPolicy).toEqual(runtimeDeny);
      return;
    }
    expectInherited(result, "completion-handoff", { allow: ["read", "exec"], deny: ["write"] });
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.inheritedToolPolicySource).toBe("sender");

    const snapshot = prepareReplyToolAuthority({
      run: {
        ...request,
        requesterOrigin: {
          sessionKey: targetSessionKey,
          messageProvider: "discord",
          senderId: "alice",
        },
        sessionFile: path.join(tempDir, "requester.jsonl"),
        workspaceDir: tempDir,
        provider: consumption.provider,
        model: consumption.model,
      },
    });
    try {
      const currentFingerprint = await snapshot.fingerprintAsync();
      current = false;
      expect(snapshot.fingerprint()).not.toBe(currentFingerprint);
    } finally {
      snapshot.close();
    }
  });

  it("uses a persisted projection for a spawn-owned dashboard child", async () => {
    const parentSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:dashboard:visible-child";
    await writeSession(childSessionKey, {
      spawnedBy: parentSessionKey,
      parentSessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
    });

    const result = await resolvePolicy({
      sessionKey: childSessionKey,
      spawnedBy: parentSessionKey,
    });

    expectInherited(result, "persisted-child", {
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    });
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.subagentPolicy).toBeDefined();
  });

  it("keeps the sender snapshot while applying current non-sender restrictions", async () => {
    const childSessionKey = "agent:main:subagent:web-search";
    await writeChild(childSessionKey);
    const cfg = config({ tools: { toolsBySender: { "*": { deny: ["web_search"] } } } });

    const searchPolicy = (searchConfig: OpenClawConfig, sessionKey = childSessionKey) =>
      withPreparedSessionCapabilityRead(() =>
        resolveWebSearchToolPolicy({ config: searchConfig, agentId: "main", sessionKey }),
      );
    const denied = { allowed: false, persistentAllowed: false };
    expect(await searchPolicy(cfg)).toEqual({ allowed: true, persistentAllowed: true });
    expect(await searchPolicy({ ...cfg, tools: { ...cfg.tools, deny: ["web_search"] } })).toEqual(
      denied,
    );
    expect(await searchPolicy(cfg, "agent:main:subagent:forged")).toEqual(denied);
  });

  it("lets a session-event web_search entry pass only while current policy allows it", () => {
    const runtimeToolAllowlist = ["read", "web_search"];
    expect(resolveWebSearchToolPolicy({ runtimeToolAllowlist }).allowed).toBe(true);
    expect(resolveWebSearchToolPolicy({ runtimeToolAllowlist: [] })).toEqual({
      allowed: false,
      persistentAllowed: true,
    });
    expect(
      resolveWebSearchToolPolicy({
        runtimeToolAllowlist,
        config: { tools: { deny: ["web_search"] } },
      }).allowed,
    ).toBe(false);
  });

  it("does not re-resolve group sender policy for a verified child", async () => {
    const parentSessionKey = "agent:main:telegram:group:dev";
    const childSessionKey = "agent:main:subagent:group-child";
    await writeChild(childSessionKey, { spawnedBy: parentSessionKey });
    const group = { toolsBySender: { "*": { deny: ["read"] }, "id:alice": {} } };
    const cfg = config({ channels: { telegram: { groups: { dev: group } } } });

    const params = {
      config: cfg,
      spawnedBy: parentSessionKey,
      messageProvider: "telegram",
      groupId: "dev",
    };
    const child = await resolvePolicy({ ...params, sessionKey: childSessionKey });
    const forged = await resolvePolicy({ ...params, sessionKey: "agent:main:subagent:forged" });

    expect(child.delegated).toBe(true);
    expect(child.groupPolicy).toBeUndefined();
    expect(forged.delegated).toBe(false);
    expect(forged.groupPolicy).toEqual({ deny: ["read"] });
  });

  it.each(["partial lineage", "unversioned legacy", "sender identity", "external provenance"])(
    "applies current policy to a child with %s",
    async (kind) => {
      const childSessionKey = "agent:main:subagent:current-policy";
      const partial = kind === "partial lineage";
      const external = kind === "sender identity" || kind === "external provenance";
      if (partial) {
        await writeSession(childSessionKey, { spawnedBy: requester });
      } else {
        await writeChild(childSessionKey, {
          inheritedToolPolicyVersion: kind === "unversioned legacy" ? undefined : 1,
          inheritedToolDeny: ["message"],
          inheritedToolPolicySource: external ? "sender" : undefined,
        });
      }
      const result = await resolvePolicy({
        sessionKey: childSessionKey,
        ...(external ? { messageProvider: "discord" } : {}),
        ...(kind === "sender identity" ? { senderId: "bob" } : {}),
        ...(kind === "external provenance"
          ? { inputProvenance: { kind: "external_user" as const } }
          : {}),
      });
      expectCurrentPolicy(result);
      if (!partial) {
        expect(result.inheritedToolPolicy).toEqual({ deny: ["message"] });
      }
      if (external) {
        expect(result.inheritedToolPolicySource).toBe("sender");
      }
    },
  );

  it.each([false, true])(
    "applies current requester policy to a fresh child followup while retaining its ceiling (delegated=%s)",
    async (delegated) => {
      const requesterSessionKey = "agent:front:discord:direct:alice";
      const childSessionKey = "agent:worker:subagent:policy-admission";
      await writeChild(childSessionKey, {
        spawnedBy: requesterSessionKey,
        inheritedToolDeny: delegated ? ["message", "write"] : ["message"],
        ...(delegated
          ? {
              delegatedToolPolicy: {
                requesterSessionKey,
                targetAgentId: "worker",
                deny: ["message"],
                requesterDeny: ["message", "write"],
              },
            }
          : {}),
      });
      const cfg = workerConfig();
      const request = {
        agentId: "worker",
        sessionKey: childSessionKey,
        requesterOrigin: {
          sessionKey: requesterSessionKey,
          messageProvider: "discord",
          senderId: "alice",
        },
        inputProvenance: {
          kind: "inter_session" as const,
          sourceSessionKey: requesterSessionKey,
          sourceTool: "sessions_send",
        },
      };
      const admitted = await resolvePolicy({ config: cfg, ...request });
      const nextConfig = config({
        ...cfg,
        tools: {
          ...cfg.tools,
          toolsBySender: { ...cfg.tools?.toolsBySender, "id:alice": { deny: ["exec"] } },
        },
      });
      const next = await resolvePolicy({ config: nextConfig, ...request });

      expect(next.senderPolicy).toEqual({ deny: ["exec"] });
      expect(next.inheritedToolPolicy).toEqual({ deny: ["message"] });
      expect(next.inheritedToolPolicySource).toBe("sender");
      expect(admitted.senderPolicy).toBeUndefined();
      expect(admitted.inheritedToolPolicy).toEqual({ deny: ["message"] });
    },
  );

  const run = "agent:main:cron:nightly:run:r1";
  const scheduledRun = "scheduled-run" as const;
  // Spawn persists the run's fresh session with the mark; admission compares keys only.
  const marked = { inheritedToolPolicySource: scheduledRun, inheritedToolPolicyRunSessionKey: run };
  // Any turn on the run's session carries this origin; only the run's own turn stamps it.
  const runOrigin = { sessionKey: run };
  const fromRun = { ...runOrigin, scheduledRunSessionKey: run };
  const unrestrictedConfig = () =>
    config({ tools: { toolsBySender: { "*": { alsoAllow: ["browser"] } } } });
  const crossAgentSpawnError = (result: ReturnType<typeof resolveRequesterToolPolicies>) =>
    resolveSenderRestrictedSpawnError({
      inheritedToolPolicySource: result.inheritedToolPolicySource,
      requesterAgentId: "main",
      targetAgentId: "ops",
    });

  it.each<{ kind: string; origin: RequesterOrigin }>([
    { kind: "scheduled run", origin: fromRun },
    { kind: "blank sender", origin: { ...fromRun, senderId: " " } },
  ])("keeps the sender snapshot for a child of a senderless $kind", async ({ origin }) => {
    const childSessionKey = "agent:main:subagent:senderless-child";
    await writeChild(childSessionKey, {
      spawnedBy: run,
      inheritedToolDeny: ["message"],
      ...marked,
    });

    const result = await resolvePolicy({ sessionKey: childSessionKey, requesterOrigin: origin });

    expectInherited(result, "persisted-child", { deny: ["message"] });
    expect(result.senderPolicy).toBeUndefined();
    expect(result).toMatchObject(marked);
    // Like the run itself, its child may still start a helper of another agent.
    expect(crossAgentSpawnError(result)).toBeUndefined();
  });

  const onRun = { senderPolicyMode: "never", trustedScheduledRunSessionKey: run } as const;
  const runR2 = "agent:main:cron:nightly:run:r2";
  type ProvenanceRequest = Partial<Parameters<typeof resolveRequesterToolPolicies>[0]>;

  it.each<[string, ProvenanceRequest, ("sender" | "scheduled-run")?]>([
    ["a run on its fresh session", onRun, scheduledRun],
    ["a run with its own origin", { ...onRun, requesterOrigin: runOrigin }, scheduledRun],
    ["a run-shaped key", { senderPolicyMode: "never", sessionKey: "agent:main:cron:x:run:s" }],
    ["the fact for another run", { ...onRun, trustedScheduledRunSessionKey: runR2 }],
    ["sender policy", { trustedScheduledRunSessionKey: run, config: unrestrictedConfig() }],
    ["a restrictive guest entry", { trustedScheduledRunSessionKey: run }, "sender"],
    ["a conversation policy", { ...onRun, conversationPolicy: { deny: ["write"] } }, "sender"],
    ["an operator turn", { ...onRun, operatorProfileId: "operator-b" }],
    [
      "an operator origin",
      { ...onRun, requesterOrigin: { ...runOrigin, operatorProfileId: "op" } },
    ],
    ["a sender origin", { ...onRun, requesterOrigin: { ...runOrigin, senderId: "bob" } }],
    ["a sender", { ...onRun, senderId: "bob" }],
    ["another session", { ...onRun, sessionKey: "agent:main:main", requesterOrigin: runOrigin }],
    ["another origin", { ...onRun, requesterOrigin: { sessionKey: "agent:main:main" } }],
  ])("records the spawn provenance of a run turn with %s", async (_kind, request, source) => {
    const result = await resolvePolicy({ sessionKey: run, ...request });

    expectCurrentSource(result);
    expect(result.inheritedToolPolicySource).toBe(source);
    expect(result.inheritedToolPolicyRunSessionKey).toBe(source === scheduledRun ? run : undefined);
  });

  it.each([
    { kind: "a run's own Gateway turn", bound: true, source: scheduledRun },
    { kind: "an operator's Gateway turn on a run", bound: true, operatorProfileId: "operator-b" },
    { kind: "a Gateway turn without the runner's fact", bound: false },
  ])("records a Gateway turn's spawn provenance for $kind", async (row) => {
    const admittedRunContext = createTestAdmittedRunContext("run-1");
    const context = { freshRunSessionKey: run } as unknown as ScheduledExecutionContext;
    const unbind = row.bound
      ? bindScheduledExecutionContext(admittedRunContext.operationalRunInstance, context)
      : () => undefined;
    try {
      const result = await resolveGatewayRequesterToolPolicies(
        {
          cfg: config(),
          operatorProfileId: row.operatorProfileId,
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          admittedRunContext,
        },
        { runtimePolicySessionKey: run, policyAgentId: "main", nodeExecSurface: false },
      );

      expectCurrentSource(result);
      expect(result.inheritedToolPolicySource).toBe(row.source);
      expect(result.inheritedToolPolicyRunSessionKey).toBe(row.source ? run : undefined);
    } finally {
      unbind();
    }
  });

  it("applies the guest entries when a senderless run in a shared room sends work to a child", async () => {
    const room = "agent:main:telegram:group:dev";
    const childSessionKey = "agent:main:subagent:room-child";
    await writeChild(childSessionKey, { spawnedBy: room, inheritedToolDeny: ["message"] });
    const group = { tools: { deny: ["write"] }, toolsBySender: { "*": { deny: ["read"] } } };

    const result = await resolvePolicy({
      config: config({ channels: { telegram: { groups: { dev: group } } } }),
      sessionKey: childSessionKey,
      requesterOrigin: {
        sessionKey: room,
        messageProvider: "telegram",
        chatType: "group",
        groupId: "dev",
      },
    });

    expectInherited(result, "persisted-child", { deny: ["message"] });
    expect(result.senderPolicy).toEqual(runtimeDeny);
    expect(result.groupPolicy).toEqual({ deny: ["read"] });
    expect(result.inheritedToolPolicySource).toBe("sender");
  });

  it("keeps a nested run child's snapshot reading only the child's own row", async () => {
    const parent = "agent:main:subagent:parent";
    const nested = "agent:main:subagent:nested";
    await writeSession(run, {});
    await writeChild(parent, { spawnedBy: run, ...marked });
    await writeChild(nested, {
      spawnedBy: parent,
      spawnDepth: 2,
      inheritedToolDeny: ["message"],
      ...marked,
    });
    const reads: SessionCapabilitySnapshot["query"][] = [];

    const result = await withPreparedSessionCapabilityRead(
      () =>
        resolveRequesterToolPolicies({
          config: config(),
          agentId: "main",
          sessionKey: nested,
          requesterOrigin: fromRun,
        }),
      { onRead: ({ query }) => reads.push(query) },
    );

    expectInherited(result, "persisted-child", { deny: ["message"] });
    expect(result.senderPolicy).toBeUndefined();
    expect(result).toMatchObject(marked);
    expect(new Set(reads.map((query) => query.sessionKey ?? query.sessionId))).toEqual(
      new Set([nested]),
    );
  });

  it("replays a prepared run child's policy after the run's own row is rewritten", async () => {
    const childSessionKey = "agent:main:subagent:retained-child";
    await writeSession(run, { agentHarnessId: "pi" });
    const child = { spawnedBy: run, inheritedToolDeny: ["message"], ...marked };
    await writeChild(childSessionKey, child);
    const prepared = await prepareSessionCapabilityRead(() =>
      resolveRequesterToolPolicies({
        config: config(),
        agentId: "main",
        sessionKey: childSessionKey,
        requesterOrigin: fromRun,
      }),
    );
    try {
      await writeSession(run, { sessionId: "run-session-rotated", agentHarnessId: "codex" });
      const replayed = prepared.read();
      expect(replayed.senderPolicy).toBeUndefined();
      expect(replayed).toMatchObject(marked);
      // The child's own row stays a dependency of the prepared read.
      await writeChild(childSessionKey, { ...child, inheritedToolDeny: ["exec"] });
      expect(() => prepared.read()).toThrow("Session capability metadata changed");
    } finally {
      prepared.release();
    }
  });

  const unmarked = { inheritedToolPolicySource: undefined };
  const noRunKey = { inheritedToolPolicyRunSessionKey: undefined };

  it.each<[string, RequesterOrigin, Partial<SessionEntry>?, string?]>([
    ["another session", { sessionKey: "agent:main:hook:inbox" }],
    ["another turn on the run's session", runOrigin],
    ["a stamp for another run", { ...fromRun, scheduledRunSessionKey: runR2 }],
    [
      "the run's stamp on another session",
      { sessionKey: "agent:main:main", scheduledRunSessionKey: run },
    ],
    ["a later run of the same job", { sessionKey: runR2 }],
    ["an operator origin on the spawning run", { ...fromRun, operatorProfileId: "operator-b" }],
    ["an operator turn with the run's origin", fromRun, {}, "op"],
    ["a sender on the run's origin", { ...fromRun, senderId: "bob" }],
    ["a mark without its run session", fromRun, noRunKey],
    ["a run session without the mark", fromRun, unmarked],
    ["a child spawned before runs recorded their policy", fromRun, { ...unmarked, ...noRunKey }],
  ])("resolves current sender policy for %s", async (_kind, origin, child, operator) => {
    const childSessionKey = "agent:main:subagent:senderless-child";
    await writeChild(childSessionKey, {
      spawnedBy: run,
      inheritedToolDeny: ["message"],
      ...marked,
      ...child,
    });
    const request = {
      sessionKey: childSessionKey,
      requesterOrigin: origin,
      operatorProfileId: operator,
    };

    const result = await resolvePolicy(request);
    const unrestricted = await resolvePolicy({ ...request, config: unrestrictedConfig() });

    expectInherited(result, "persisted-child", { deny: ["message"] });
    expect(result.senderPolicy).toEqual(runtimeDeny);
    expect(crossAgentSpawnError(result)).toBeDefined();
    expect(unrestricted.senderPolicy).toEqual({ allow: ["*", "browser"] });
    expect(unrestricted.inheritedToolPolicySource).toBeUndefined();
    expect(unrestricted.inheritedToolPolicyRunSessionKey).toBeUndefined();
  });

  it("reports a sender restriction when a conversation policy restricts a run child's admission", async () => {
    const childSessionKey = "agent:main:subagent:conversation-run-child";
    await writeChild(childSessionKey, {
      spawnedBy: run,
      inheritedToolDeny: ["message"],
      ...marked,
    });

    const result = await resolvePolicy({
      sessionKey: childSessionKey,
      requesterOrigin: fromRun,
      conversationPolicy: { deny: ["write"] },
    });

    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toEqual({ deny: ["write"] });
    expect(result.inheritedToolPolicySource).toBe("sender");
    expect(result.inheritedToolPolicyRunSessionKey).toBeUndefined();
  });

  it("does not treat a run child's spawn provenance as a sender restriction", async () => {
    const childSessionKey = "agent:main:subagent:channel-child";
    await writeChild(childSessionKey, { spawnedBy: run, ...marked });

    const result = await resolvePolicy({
      config: unrestrictedConfig(),
      sessionKey: childSessionKey,
      senderId: "bob",
    });

    expectCurrentSource(result);
    expect(result.inheritedToolPolicySource).toBeUndefined();
  });

  it("keeps a run child's spawn provenance for an origin-free resume", async () => {
    const childSessionKey = "agent:main:subagent:resumed-child";
    await writeChild(childSessionKey, { spawnedBy: run, ...marked });

    const result = await resolvePolicy({ sessionKey: childSessionKey });

    expect(result).toMatchObject({ delegated: true, requesterPolicySource: "persisted-child" });
    expect(result.senderPolicy).toBeUndefined();
    expect(result).toMatchObject(marked);
  });

  it.each([
    { kind: "one run", second: marked, kept: true },
    { kind: "a run and an unmarked spawn", second: {}, kept: false },
    {
      kind: "two runs",
      second: { ...marked, inheritedToolPolicyRunSessionKey: "agent:main:cron:nightly:run:r2" },
      kept: false,
    },
  ])("settles children spawned by $kind", async ({ kind, second, kept }) => {
    const sourceSessionKeys = ["agent:main:subagent:first", "agent:main:subagent:second"] as const;
    for (const [index, sessionKey] of sourceSessionKeys.entries()) {
      await writeChild(sessionKey, {
        spawnedBy: run,
        inheritedToolDeny: ["write"],
        ...(index === 0 ? marked : second),
      });
    }
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey: run,
      targetSessionId: "run-session",
      idempotencyKey: `run-batch-${kind}`,
      settleBatch: { sourceSessionKeys, isCurrent: () => true },
    };
    const consumption = {
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      provider: "openai",
      model: "gpt-test",
    };

    const result = await resolvePolicy({
      sessionKey: run,
      sessionId: registration.targetSessionId,
      modelProvider: consumption.provider,
      modelId: consumption.model,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_settle",
        sourceSessionKey: registration.sourceSessionKey,
      },
      trustedInternalHandoff: consumeSubagentCompletionToolHandoff(consumption),
    });

    expectInherited(result, "completion-handoff", { deny: ["write"] });
    expect(result.inheritedToolPolicySource).toBe(kept ? scheduledRun : undefined);
    expect(result.inheritedToolPolicyRunSessionKey).toBe(kept ? run : undefined);
  });

  it("fails closed when a trusted internal handoff has no configuration", () => {
    expect(() =>
      resolveRequesterToolPolicies({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        ...completionHandoffFacts("agent:ops:subagent:child", "agent:ops:main"),
      }),
    ).toThrow("Trusted internal handoff policy resolution requires configuration.");
  });

  it("restores a verified completion handoff to a distinct immutable completion owner", async () => {
    const controllerSessionKey = requester;
    const completionOwnerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:child";
    await writeChild(childSessionKey, {
      spawnedBy: controllerSessionKey,
      completionOwnerSessionKey,
      inheritedToolAllow: ["read", "exec"],
    });

    const handoff = completionHandoffFacts(childSessionKey, completionOwnerSessionKey);
    const result = await resolvePolicy({
      config: config({ tools: { toolsBySender: { "id:alice": { deny: ["exec"] } } } }),
      sessionKey: completionOwnerSessionKey,
      requesterOrigin: {
        sessionKey: controllerSessionKey,
        messageProvider: "discord",
        senderId: "alice",
      },
      ...handoff,
    });

    expectInherited(result, "completion-handoff", { allow: ["read", "exec"] });
    expect(result.senderPolicy).toBeUndefined();
    const controllerResult = await resolvePolicy({ sessionKey: controllerSessionKey, ...handoff });
    expectCurrentSource(controllerResult);
  });

  it("does not treat an ordinary dashboard key as a completion authority", async () => {
    const childSessionKey = "agent:main:dashboard:operator-thread";
    await writeSession(childSessionKey, { spawnDepth: 0 });

    const result = await resolvePolicy({
      sessionKey: "agent:main:main",
      ...completionHandoffFacts(childSessionKey, "agent:main:main"),
    });

    expectCurrentSource(result);
  });

  it.each([
    ["requester", ["exec"]],
    ["parent-child resume envelope", ["exec", "read"]],
  ] as const)("restores the nested completion projection for %s", async (target, deny) => {
    const parent = "agent:main:subagent:parent-child";
    const leaf = "agent:main:subagent:leaf";
    await writeChild(parent, { inheritedToolDeny: ["exec"] });
    await writeChild(leaf, {
      spawnedBy: parent,
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolDeny: ["exec", "read"],
    });
    const sessionKey = target === "requester" ? requester : parent;
    const result = await resolvePolicy({
      sessionKey,
      ...(target === "requester" ? {} : { subagentSessionKey: parent }),
      ...completionHandoffFacts(leaf, sessionKey),
    });
    expectInherited(result, "completion-handoff", { deny: [...deny] });
  });

  it("fails closed for untrusted or mismatched completion handoffs", async () => {
    const childSessionKey = "agent:main:subagent:child";
    await writeChild(childSessionKey);
    const handoff = completionHandoffFacts(childSessionKey, requester);
    const resolveHandoff = (sessionKey: string, trusted = true) =>
      resolveRequesterToolPolicies({
        config: config(),
        agentId: "main",
        sessionKey,
        ...handoff,
        trustedInternalHandoff: trusted ? handoff.trustedInternalHandoff : undefined,
      });
    const untrusted = resolveHandoff(requester, false);
    const mismatched = resolveHandoff("agent:main:discord:direct:bob");
    const mismatchedCompletionOwner = resolveHandoff("agent:main:main");

    expectCurrentPolicy(untrusted);
    expectCurrentPolicy(mismatched);
    expectCurrentSource(mismatchedCompletionOwner);
  });
});
