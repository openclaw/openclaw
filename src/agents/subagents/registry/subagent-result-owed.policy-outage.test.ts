import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { resolvePreparedGatewayOperatorAccessAuthority } from "../../../gateway/operator-access-policy.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { bindPluginGatewayAccessPolicy } from "../../../plugins/gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { useCompletionDatabase } from "../completion/completion-database.test-support.js";
import { SessionFollowupCompletion } from "../completion/session-followup-completion.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";

// mock-isolation: the local lifecycle controller is the sole registry owner; the real one starts a global sweeper.
vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const db = useCompletionDatabase("openclaw-result-policy-outage-");
afterEach(() => {
  publishSystemEventStoreResolver(undefined);
  clearRuntimeConfigSnapshot();
});

it("keeps a finished child's result owed when its followup access policy is temporarily unavailable", async () => {
  setRuntimeConfigSnapshot({});
  const input = armRequesterWake(records());
  const child = input.subagent;
  child.delivery = { status: "pending", generation: 1 };
  child.requesterSettleWake!.requesterYieldBatch = true;
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  child.requesterStorePath = storePath;
  child.completionRequesterSessionId = "policy-requester";
  child.completionRequesterLifecycleRevision = "policy-requester-revision";
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: child.requesterSessionKey, storePath },
    {
      sessionId: "policy-requester",
      lifecycleRevision: "policy-requester-revision",
      updatedAt: Date.now(),
    },
  );
  publishSystemEventStoreResolver(() => storePath);
  seedSubagentCompletionOwner({ subagent: child, databaseOptions: { database: db.value } });

  const instance = createOwnedTestInstance("result-policy");
  const grant = new AbortController();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "result-policy" }));
  registry.gatewayAccessPolicies.push({
    pluginId: "result-policy",
    source: "fixture",
    policy: bindPluginGatewayAccessPolicy(
      {
        authorize: () => ({
          signal: grant.signal,
          assertCurrent: () => grant.signal.throwIfAborted(),
        }),
      },
      instance,
    ),
  });
  const previous = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(registry, null, "default");
  let followup: SessionFollowupCompletion | undefined;
  using driver = requesterWakeDriver([input]);
  // Unlike the existing dispatch-only outage proof, the real lifecycle owner persists
  // the real wake owner's rejection; neither failure classification nor storage is mocked.
  driver.wake.mockImplementation(maybeWakeRequesterAfterAllChildrenSettled);
  try {
    const authority = resolvePreparedGatewayOperatorAccessAuthority(
      { profileId: "result-requester", emails: [], role: null, isCurrent: () => true },
      {},
    );
    expect(authority).not.toBeNull();
    followup = SessionFollowupCompletion.bind({
      runId: "followup-before-policy-outage",
      requesterSessionKey: "agent:main:original-requester",
      requesterSessionId: "original-requester",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: child.requesterSessionKey,
      custody: {
        signal: authority!.signal,
        assertCurrent: () => authority!.assertCurrent(),
        release() {},
        run: (run) => run(),
        runWithRequester: (run) => run(),
      },
    });
    followup.promoteYield("followup-before-policy-outage", [child], 1);
    followup.finishExecution("followup-before-policy-outage");

    // Quiescing the real policy plugin is an outage, not grant revocation.
    instance.quiesce();
    expect(() => authority!.assertCurrent()).toThrow(
      "Gateway access policy is unavailable; retry the operation.",
    );
    expect(authority!.signal.aborted).toBe(false);
    await driver.run();
    const duringOutage = loadSubagentRegistryFromSqlite().get(child.runId)!;

    instance.resume();
    expect(() => authority!.assertCurrent()).not.toThrow();
    await driver.sweep();
    const afterRecovery = loadSubagentRegistryFromSqlite().get(child.runId)!;

    // A retained answer without an owed delivery is not recovery: the normal sweep
    // must still own a continuation unless the requester actually received it.
    expect(duringOutage.completion?.resultText).toBe("canonical result");
    expect(duringOutage.requesterSettleWake, JSON.stringify(duringOutage.delivery)).toBeDefined();
    expect(duringOutage.delivery?.status).toBe("pending");
    expect(afterRecovery.completion?.resultText).toBe("canonical result");
    expect(
      afterRecovery.delivery?.status === "delivered" ||
        (afterRecovery.requesterSettleWake !== undefined &&
          afterRecovery.delivery?.status === "pending"),
      JSON.stringify(afterRecovery.delivery),
    ).toBe(true);
  } finally {
    followup?.close();
    grant.abort();
    await instance.dispose();
    rollbackStagedPluginRegistry(previous);
  }
});
