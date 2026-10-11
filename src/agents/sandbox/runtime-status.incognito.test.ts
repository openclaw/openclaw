import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assertAgentHarnessExecutionEnvironment } from "../harness/execution-environment.js";
import { readSessionRuntimeOwnership } from "../harness/session-runtime-ownership.js";
import type { AgentHarness } from "../harness/types.js";
import {
  resolveSandboxRuntimeStatus,
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

it("classifies unbound memory policy and rejects execution after permission or sandbox changes", async () => {
  await withOpenClawTestState({ label: "memory-policy" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-policy";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all" } } },
      session: { store: storePath },
    };
    const scope = { agentId: "main", sessionKey, storePath, env: state.env };
    const source = { env: state.env, cwd: state.env.OPENCLAW_STATE_DIR!, assertCurrent() {} };
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
        config: cfg,
        agentId: "main",
        sessionKey,
        sessionId: "policy",
        permissionMode: "full" as const,
      };
      expect(resolveSandboxRuntimeStatus({ cfg, sessionKey }).sandboxed).toBe(false);
      expect(assertAgentHarnessExecutionEnvironment(harness, params)).toBe(true);
      expect(
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey,
          preparedSessionEntry: { sandbox: "required" },
        }).sandboxRequired,
      ).toBe(true);
      await expect(
        withSandboxRuntimeStatusesInWorker([{ cfg, sessionKey }], source, (statuses) => statuses),
      ).resolves.toMatchObject([{ sandboxed: false }]);
      await upsertSessionEntryCore(scope, { permissionMode: "workspace" });
      expect(() => assertAgentHarnessExecutionEnvironment(harness, params)).toThrow(
        "requires Full access",
      );
      await expect(
        withSandboxRuntimeStatusInWorker({ cfg, sessionKey }, source, async () => {
          await upsertSessionEntryCore(scope, { sandboxMode: undefined });
          return "prepared";
        }),
      ).rejects.toThrow("Session entry changed during read");
      expect(resolveSandboxRuntimeStatus({ cfg, sessionKey })).toMatchObject({
        sandboxRequired: false,
        sandboxed: true,
      });
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
    }
  });
});

it("classifies absent incognito sessions without allocating an owner", async () => {
  await withOpenClawTestState({ label: "memory-policy-absent" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-absent";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all" } } },
      session: { store: storePath },
    };
    expect(resolveSandboxRuntimeStatus({ cfg, sessionKey })).toMatchObject({
      sandboxed: true,
      sandboxRequired: false,
    });
    await expect(
      withSandboxRuntimeStatusesInWorker(
        [{ cfg, sessionKey }],
        {
          env: state.env,
          cwd: state.env.OPENCLAW_STATE_DIR!,
          assertCurrent() {},
        },
        (statuses) => statuses,
      ),
    ).resolves.toMatchObject([{ sandboxed: true, sandboxRequired: false }]);
    expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
  });
});

it("reads current memory predecessor lineage and retires the scoped runtime reader", async () => {
  await withOpenClawTestState({ label: "memory-policy-lineage" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-lineage";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const scope = { agentId: "main", sessionKey, storePath, env: state.env };
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
