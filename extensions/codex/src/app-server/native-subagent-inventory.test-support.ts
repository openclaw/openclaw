import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { Type } from "typebox";
import { onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import { createNativeSubagentAssignmentStore } from "./native-subagent-assignment-store.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  createNativeModelSourceFixture,
  directSpawnItem,
  nativeHistoryOwner,
  successfulSendInputOutput,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import { createParams, tempDir } from "./run-attempt-test-harness.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

export async function fixture() {
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: "physical-1",
    sessionKey: "agent:main:inventory",
  };
  await seedRunSessionOwnerForTest(identity.sessionId, identity.sessionKey, {
    lifecycleRevision: "inventory-generation",
  });
  const entry = getSessionEntry({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath: resolveStorePath(undefined, { agentId: identity.agentId }),
  });
  assert(entry?.lifecycleRevision);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const lifecycleRevision = entry.lifecycleRevision;
  const historyOwner = (parentThreadId = "parent-thread") => ({
    ...nativeHistoryOwner(parentThreadId),
    lifecycleRevision,
  });
  const binding = {
    threadId: "parent-thread",
    cwd: tempDir,
    appServerRuntimeFingerprint: "connection-A",
  };
  const state = createCodexTestBindingStateStore();
  const store = createCodexAppServerBindingStore(state);
  await store.mutate(identity, { kind: "set", binding });
  const deliver = vi.fn(defaultNativeSubagentMonitorRuntime.deliverAgentHarnessCompletion);
  // Isolate outbound user delivery only; capture/isCurrent/retain are the real host contract.
  deliver.mockImplementation(async ({ completionCustody }) => {
    assert(completionCustody?.isCurrent(), "Delivery must retain real, current host custody");
    return { delivered: true, path: "direct" };
  });
  const runtime = {
    ...defaultNativeSubagentMonitorRuntime,
    deliverAgentHarnessCompletion: deliver,
  };
  let sequence = 0;
  const register = async (
    client: ReturnType<typeof createClient>,
    owner = historyOwner(),
    modelSource?: ReturnType<typeof createNativeModelSourceFixture>,
    configurationQualification?: CodexInferenceThreadQualification,
    options: {
      bindingStore?: CodexAppServerBindingStore;
      retainParentThread?: (threadId: string) => () => void;
    } = {},
  ) => {
    const registrationStore = options.bindingStore ?? store;
    const params = createParams(`${tempDir}/inventory-${++sequence}.jsonl`, tempDir, {
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      runId: `inventory-${sequence}`,
    });
    params.agentId = identity.agentId;
    const host = await createAdmittedHostCapabilityTestFixture(params, { gatewayContext: true });
    onTestFinished(() => {
      host.closeHost();
      host.closeAdmission();
      host.closeGateway();
    });
    assert(host.agentHarnessCompletionScope);
    const completionScope = host.agentHarnessCompletionScope;
    const assignmentStore = createNativeSubagentAssignmentStore({
      bindingStore: registrationStore,
      identity,
      owner,
    });
    const submissionStore: CodexNativeSubagentSubmissionStore = {
      assertCurrent: () => assignmentStore.assertCurrent(),
      read: () => registrationStore.readNativeSubagentSubmissions(identity, owner),
      record: (receipt, assertCurrent) =>
        registrationStore.mutate(
          identity,
          { kind: "record-native-subagent-submission", owner, receipt },
          assertCurrent,
        ),
      consume: (receipt, assertCurrent) =>
        registrationStore.mutate(
          identity,
          { kind: "consume-native-subagent-submission", owner, receipt },
          assertCurrent,
        ),
    };
    ensureCodexAppServerClientRuntime(client.client, { agentDir: tempDir });
    const registered =
      createDeferred<Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>>();
    const tool = host.hostCapabilities.bindToolSurface([
      {
        name: "register_native_inventory",
        label: "Register native inventory",
        description: "Test registration",
        parameters: Type.Object({}),
        execute: async () => {
          registered.resolve(
            await codexNativeSubagentMonitorRuntime.register({
              client: client.client,
              parentThreadId: owner.parentThreadId,
              requesterSessionKey: identity.sessionKey,
              completionScope,
              historyOwner: owner,
              assignmentStore,
              submissionStore,
              runtime,
              configurationQualification,
              retainParentThread: options.retainParentThread,
              ...(modelSource ? { modelSource } : {}),
            }),
          );
          return { content: [{ type: "text", text: "registered" }], details: {} };
        },
      },
    ])[0];
    assert(tool);
    await host.runWithGatewayScope(() => tool.execute("register", {}));
    return {
      ...(await registered.promise),
      closeGateway: host.closeGateway,
      closeCaller: () => {
        host.closeHost();
        host.closeAdmission();
      },
    };
  };
  const spawn = async (client: ReturnType<typeof createClient>, observeTurn = true) => {
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: { id: "spawn", ...directSpawnItem("v1", "parent-thread", "child-thread") },
      },
    });
    await client.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "function_call_output",
          call_id: "spawn",
          output: JSON.stringify({ agent_id: "child-thread" }),
        },
      },
    });
    if (observeTurn) {
      await client.notify(turnStartedNotification("child-turn"));
    }
  };
  return {
    identity,
    binding,
    store,
    deliver,
    register,
    spawn,
    historyOwner,
    newBindingStore: () => createCodexAppServerBindingStore(state),
  };
}

export async function completeInForeground(client: ReturnType<typeof createClient>) {
  await client.notify(
    childTurnCompletedNotification({
      status: "completed",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Native result" }],
    }),
  );
  await client.notify({
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        id: "wait",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed", message: "Native result" } },
      },
    },
  });
}

export async function submitFollowup(client: ReturnType<typeof createClient>) {
  await client.notify({
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        id: "followup",
        type: "collabAgentToolCall",
        tool: "sendInput",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
      },
    },
  });
  await client.notify(
    successfulSendInputOutput({ callId: "followup", submissionId: "followup-turn" }),
  );
}
