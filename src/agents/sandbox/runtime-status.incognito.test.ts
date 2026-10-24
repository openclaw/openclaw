import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { assertAgentHarnessExecutionEnvironment } from "../harness/execution-environment.js";
import { readSessionRuntimeOwnership } from "../harness/session-runtime-ownership.js";
import type { AgentHarness } from "../harness/types.js";
import { resolveSandboxContext } from "./context.js";
import {
  resolveSandboxRuntimeStatus,
  resolvePreparedSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusAsync,
  resolveSandboxRuntimeStatusesForPersistedSessions,
  type SandboxRuntimeStatusParams,
  withSandboxRuntimeStatusInWorker,
  withSandboxRuntimeStatusesInWorker,
} from "./runtime-status.js";

const harness: AgentHarness = {
  id: "fixture",
  label: "Fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  async runAttempt() {
    throw new Error("unused");
  },
};
afterEach(() => memorySessionActorOwners.reset());
const enabledStatus = { sandboxed: true, sandboxRequired: false };

function memoryPolicy(state: OpenClawTestState, suffix: string) {
  const sessionKey = `agent:main:dashboard:incognito-${suffix}`;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
  const cfg: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "all" } } },
    session: { store: storePath },
  };
  return {
    request: { cfg, sessionKey },
    storePath,
    scope: { agentId: "main", sessionKey, storePath, env: state.env },
    source: { env: state.env, cwd: state.env.OPENCLAW_STATE_DIR!, assertCurrent() {} },
  };
}

it("classifies unbound memory policy and rejects execution after permission or sandbox changes", async () => {
  await withOpenClawTestState({ label: "memory-policy" }, async (state) => {
    const { request, scope, source } = memoryPolicy(state, "policy");
    const classify = () => resolveSandboxRuntimeStatus(request);
    const observe = observeHostDataSql();
    try {
      await replaceSessionEntry(scope, {
        sessionId: "policy",
        updatedAt: 1,
        incognito: true,
        permissionMode: "full",
        sandboxMode: "off",
        agentRuntimeOverride: "fixture",
        nativeRuntimeConsent: "fixture",
      });
      const params = {
        config: request.cfg,
        agentId: "main",
        sessionKey: request.sessionKey,
        sessionId: "policy",
        permissionMode: "full" as const,
      };
      expect(classify().sandboxed).toBe(false);
      await expect(assertAgentHarnessExecutionEnvironment(harness, params)).resolves.toBe(true);
      expect(
        resolveSandboxRuntimeStatus({
          ...request,
          preparedSessionEntry: { sandbox: "required" },
        }).sandboxRequired,
      ).toBe(true);
      await expect(
        withSandboxRuntimeStatusesInWorker([request], source, (statuses) => statuses),
      ).resolves.toMatchObject([{ sandboxed: false }]);
      await upsertSessionEntryCore(scope, { permissionMode: "workspace" });
      await expect(assertAgentHarnessExecutionEnvironment(harness, params)).rejects.toThrow(
        "requires Full access",
      );
      await expect(
        withSandboxRuntimeStatusInWorker(request, source, async () => {
          await upsertSessionEntryCore(scope, { sandboxMode: undefined });
          return "prepared";
        }),
      ).rejects.toThrow("Session entry changed during read");
      expect(classify()).toMatchObject(enabledStatus);
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
    }
  });
});

it("classifies absent incognito sessions without allocating an owner", async () => {
  await withOpenClawTestState({ label: "memory-policy-absent" }, async (state) => {
    const { request, storePath, source } = memoryPolicy(state, "absent");
    expect(resolveSandboxRuntimeStatus(request)).toMatchObject(enabledStatus);
    await expect(
      withSandboxRuntimeStatusesInWorker([request], source, (statuses) => statuses),
    ).resolves.toMatchObject([enabledStatus]);
    expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
  });
});

it("reads current memory predecessor lineage and retires the scoped runtime reader", async () => {
  await withOpenClawTestState({ label: "memory-policy-lineage" }, async (state) => {
    const { scope } = memoryPolicy(state, "lineage");
    const entry = {
      sessionId: "lineage",
      updatedAt: 1,
      incognito: true as const,
      modelSelectionLocked: true,
      agentHarnessId: "fixture",
      previousSessionId: "predecessor-1",
    };
    await replaceSessionEntry(scope, entry);
    const registry = createEmptyPluginRegistry();
    let retainedRead: (() => string | undefined) | undefined;
    registry.agentHarnesses.push({
      pluginId: "fixture",
      source: "fixture",
      harness: {
        ...harness,
        resolveSessionRuntimeOwnership({ readPreviousSessionId }) {
          retainedRead = readPreviousSessionId;
          const previous = readPreviousSessionId?.();
          return previous
            ? {
                model: "native",
                auth: "native",
                modelRef: { provider: "fixture", model: previous },
              }
            : undefined;
        },
      },
    });
    await withPluginRuntimeRegistryScope(registry, async () => {
      const read = () => readSessionRuntimeOwnership({ ...scope, sessionEntry: entry });
      expect(read()?.modelRef?.model).toBe("predecessor-1");
      expect(() => retainedRead?.()).toThrow("ownership changed");
      await upsertSessionEntryCore(scope, { previousSessionId: "predecessor-2" });
      expect(read()?.modelRef?.model).toBe("predecessor-2");
    });
  });
});

const optionalStatus = { sandboxed: false, sandboxRequired: false };
const requiredStatus = { sandboxed: true, sandboxRequired: true };

it("uses canonical classification identity in exact, batch, and context resolution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
    setRuntimeConfigSnapshot(cfg);
    const optional = "agent:main:optional";
    const required = "agent:main:required";
    const classify = (sessionKey: string, classificationSessionKey?: string) =>
      resolveSandboxRuntimeStatusAsync({ cfg, sessionKey, classificationSessionKey });
    for (const sessionKey of [optional, required]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          sandboxMode: "off",
          ...(sessionKey === required ? { sandbox: "required" as const } : {}),
        },
      );
    }
    expect((await classify("optional")).sandboxed).toBe(false);
    expect(await classify(optional, required)).toMatchObject(requiredStatus);
    expect(await classify(required, optional)).toMatchObject(optionalStatus);
    const [persisted] = await resolveSandboxRuntimeStatusesForPersistedSessions([
      { cfg, agentId: "main", env: state.env, sessionKeys: [optional, required] },
    ]);
    expect(persisted).toMatchObject([optionalStatus, requiredStatus]);
    const native = "agent:main:dashboard:incognito-batch";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: native },
      { sessionId: "native", updatedAt: 1, sandbox: "required", sandboxMode: "off" },
    );
    await expect(
      withSandboxRuntimeStatusesInWorker(
        ["optional", required, native].map((sessionKey) => ({
          cfg,
          agentId: "main",
          sessionKey,
        })),
        { env: state.env, cwd: state.workspaceDir, assertCurrent() {} },
        (statuses) => statuses,
      ),
    ).resolves.toMatchObject([optionalStatus, requiredStatus, requiredStatus]);
    // An opted-out session must not start or prepare any sandbox backend.
    await expect(
      resolveSandboxContext({
        config: cfg,
        sessionKey: optional,
        agentId: "main",
        workspaceDir: state.workspaceDir,
      }),
    ).resolves.toBeNull();
  });
});

it("classifies a trusted patch candidate without using the old row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:candidate";
    const prepared = (
      preparedSessionEntry: NonNullable<SandboxRuntimeStatusParams["preparedSessionEntry"]> | null,
    ) => resolvePreparedSandboxRuntimeStatus({ cfg, sessionKey, preparedSessionEntry });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "candidate", updatedAt: 1 },
    );
    expect((await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey })).sandboxed).toBe(true);
    expect(prepared({ sandboxMode: "off" }).sandboxed).toBe(false);
    expect(prepared(null).sandboxed).toBe(true);
    expect(
      prepared({
        sandbox: "required",
        sandboxMode: "off",
        createdActor: { type: "human", source: "profile", id: "creator" },
      }),
    ).toMatchObject({
      ...requiredStatus,
      isolationSubject: { kind: "profile", profileId: "creator" },
      workspaceAccess: "ro",
    });
  });
});
