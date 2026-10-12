import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { assertAgentHarnessExecutionEnvironment } from "../harness/execution-environment.js";
import { readSessionRuntimeOwnership } from "../harness/session-runtime-ownership.js";
import type { AgentHarness } from "../harness/types.js";
import {
  resolveSandboxRuntimeStatus,
  withSandboxRuntimeStatusesInWorker,
} from "./runtime-status.js";

const temporary = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
const harness: AgentHarness = {
  id: "fixture",
  label: "Fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  async runAttempt() {
    throw new Error("unused");
  },
};
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: temporary.make("incognito-policy-") };
  actor = await openIncognitoTestActor(env, authority);
});
afterAll(async () => {
  await actor.close();
});
useIncognitoNoHostSql();

it("classifies sandbox policy and revokes native consent from acknowledged actor facts", async () => {
  const sessionKey = "agent:main:dashboard:incognito-policy";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "policy",
      updatedAt: 1,
      incognito: true,
      permissionMode: "full",
      sandboxMode: "off",
      agentRuntimeOverride: "fixture",
      nativeRuntimeConsent: "fixture",
    },
  });
  await withIncognitoSessionActor(actor, async () => {
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
      withSandboxRuntimeStatusesInWorker(
        [{ cfg, sessionKey }],
        { env, cwd: env.OPENCLAW_STATE_DIR!, assertCurrent() {} },
        (statuses) => statuses,
      ),
    ).resolves.toMatchObject([{ sandboxed: false }]);
    const otherEnv = { OPENCLAW_STATE_DIR: temporary.make("incognito-policy-other-root-") };
    expect(() =>
      withSandboxRuntimeStatusesInWorker(
        [{ cfg, sessionKey }],
        { env: otherEnv, cwd: otherEnv.OPENCLAW_STATE_DIR, assertCurrent() {} },
        (statuses) => statuses,
      ),
    ).toThrow("another incognito actor");
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(otherEnv)).toEqual([]);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath: actor.path },
      { permissionMode: "workspace" },
    );
    expect(() => assertAgentHarnessExecutionEnvironment(harness, params)).toThrow(
      "requires Full access",
    );
    const requiredKey = "agent:main:dashboard:incognito-required-policy";
    await actor.sessions.create(authority, {
      sessionKey: requiredKey,
      entry: {
        sessionId: "required-policy",
        updatedAt: 1,
        incognito: true,
        sandbox: "required",
        sandboxMode: "off",
      },
    });
    expect(resolveSandboxRuntimeStatus({ cfg, sessionKey: requiredKey })).toMatchObject({
      sandboxRequired: true,
      sandboxed: true,
    });
  });
});

it("keeps selected absence noncreating and refuses a retained dead actor", async () => {
  const absentEnv = { OPENCLAW_STATE_DIR: temporary.make("incognito-policy-absent-") };
  const sessionKey = "agent:main:dashboard:incognito-absent";
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env: absentEnv, authority },
    async () => {
      expect(resolveSandboxRuntimeStatus({ cfg, sessionKey })).toMatchObject({
        sandboxed: true,
        sandboxRequired: false,
      });
      await expect(
        withSandboxRuntimeStatusesInWorker(
          [{ cfg, sessionKey }],
          { env: absentEnv, cwd: absentEnv.OPENCLAW_STATE_DIR, assertCurrent() {} },
          (statuses) => statuses,
        ),
      ).resolves.toMatchObject([{ sandboxed: true, sandboxRequired: false }]);
    },
  );
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(absentEnv)).toEqual([]);
  const ended = await openIncognitoTestActor(absentEnv, authority);
  await ended.close();
  expect(() =>
    withIncognitoSessionBinding({ actor: ended }, () =>
      resolveSandboxRuntimeStatus({ cfg, sessionKey }),
    ),
  ).toThrow("Incognito session ended");
});

it("reads current predecessor lineage for an actor runtime binding miss", async () => {
  const sessionKey = "agent:main:dashboard:incognito-lineage";
  const entry = {
    sessionId: "lineage",
    updatedAt: 1,
    incognito: true as const,
    modelSelectionLocked: true,
    agentHarnessId: "fixture",
    previousSessionId: "predecessor-1",
  };
  await actor.sessions.create(authority, { sessionKey, entry });
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
          ? { model: "native", auth: "native", modelRef: { provider: "fixture", model: previous } }
          : undefined;
      },
    },
  });
  await withPluginRuntimeRegistryScope(registry, () =>
    withIncognitoSessionActor(actor, async () => {
      const read = () =>
        readSessionRuntimeOwnership({
          agentId: "main",
          sessionKey,
          storePath: actor.path,
          sessionEntry: entry,
        });
      expect(read()?.modelRef?.model).toBe("predecessor-1");
      expect(() => retainedRead?.()).toThrow("ownership changed");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: actor.path },
        { previousSessionId: "predecessor-2" },
      );
      expect(read()?.modelRef?.model).toBe("predecessor-2");
    }),
  );
});
