import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { Type } from "typebox";
import { onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import {
  createNativeSubagentAssignmentStore,
  createNativeSubagentSessionAuthority,
  createNativeSubagentSubmissionStore,
} from "./native-subagent-assignment-store.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  collabItem,
  createClient,
  createNativeModelSourceFixture,
  directSpawnItem,
  nativeHistoryOwner,
  successfulSendInputOutput,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import { createParams, tempDir } from "./run-attempt-test-harness.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import {
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

export async function fixture(fixtureOptions: { sqlite?: boolean } = {}) {
  const identity = {
    kind: "session" as const,
    agentId: "main",
    // Session entry cleanup preserves history, so fixtures need distinct physical transcripts.
    sessionId: randomUUID(),
    sessionKey: "agent:main:inventory",
  };
  const lifecycleRevision = "inventory-generation";
  await seedRunSessionOwnerForTest(identity.sessionId, identity.sessionKey, { lifecycleRevision });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const historyOwner = (parentThreadId = "parent-thread"): CodexNativeSubagentHistoryOwner => ({
    ...nativeHistoryOwner(parentThreadId),
    sessionId: identity.sessionId,
    lifecycleRevision,
  });
  const binding = {
    threadId: "parent-thread",
    cwd: tempDir,
    appServerRuntimeFingerprint: "connection-A",
  };
  const state = fixtureOptions.sqlite
    ? createCodexSqliteTestBindingStateStore({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      })
    : createCodexTestBindingStateStore();
  const store = createCodexAppServerBindingStore(state);
  await store.mutate(identity, { kind: "set", binding });
  const deliver = vi.fn(defaultNativeSubagentMonitorRuntime.deliverAgentHarnessCompletion);
  // Isolate outbound user delivery only; capture/isCurrent/retain are the real host contract.
  deliver.mockImplementation(async ({ completionCustody }) => {
    assert(completionCustody?.isCurrent(), "Delivery must retain real, current host custody");
    return { delivered: true, path: "direct" };
  });
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
    const parent = await captureSessionEntryCurrentCheckAsync({
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      storePath: resolveStorePath(undefined, { agentId: identity.agentId }),
    });
    const authority = createNativeSubagentSessionAuthority(parent);
    const prepared = fixtureOptions.sqlite
      ? await registrationStore.prepareNativeSubagentGuard(identity, owner)
      : undefined;
    if (fixtureOptions.sqlite) {
      assert(prepared);
      onTestFinished(() => prepared.release());
    }
    const storeOptions = {
      bindingStore: registrationStore,
      assertBindingCurrent:
        prepared?.assertCurrent ??
        (() => {
          const current = registrationStore.read(identity);
          if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
            throw new Error("Native subagent binding is no longer current.");
          }
        }),
      identity,
      owner,
      assertLifecycleCurrentAsync: parent.assertCurrent,
      authority,
    };
    ensureCodexAppServerClientRuntime(client.client, { agentDir: tempDir });
    const registration: {
      value?: Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>;
    } = {};
    const tool = host.hostCapabilities.bindToolSurface([
      {
        name: "register_native_inventory",
        label: "Register native inventory",
        description: "Test registration",
        parameters: Type.Object({}),
        execute: async () => {
          registration.value = await codexNativeSubagentMonitorRuntime.register({
            client: client.client,
            parentThreadId: owner.parentThreadId,
            requesterSessionKey: identity.sessionKey,
            requesterStorePath: resolveStorePath(undefined, { agentId: identity.agentId }),
            agentId: identity.agentId,
            completionScope,
            historyOwner: owner,
            assignmentStore: createNativeSubagentAssignmentStore(storeOptions),
            submissionStore: createNativeSubagentSubmissionStore(storeOptions),
            assertCurrentAsync: parent.assertCurrent,
            runtime: {
              ...defaultNativeSubagentMonitorRuntime,
              deliverAgentHarnessCompletion: deliver,
            },
            configurationQualification,
            retainParentThread: options.retainParentThread,
            ...(modelSource ? { modelSource } : {}),
          });
          return { content: [{ type: "text", text: "registered" }], details: {} };
        },
      },
    ])[0];
    assert(tool);
    await host.runWithGatewayScope(() => tool.execute("register", {}));
    assert(registration.value);
    return {
      ...registration.value,
      bindingAuthority: authority,
      closeGateway: host.closeGateway,
      closeCaller: () => {
        host.closeHost();
        host.closeAdmission();
      },
    };
  };
  const spawn = async (client: ReturnType<typeof createClient>, observeTurn = true) => {
    await client.item({ id: "spawn", ...directSpawnItem("v1", "parent-thread", "child-thread") });
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
    state,
    store,
    deliver,
    register,
    spawn,
    historyOwner,
    assignments: (owner = historyOwner()) => store.readNativeSubagentAssignments?.(identity, owner),
    submissions: (owner = historyOwner()) => store.readNativeSubagentSubmissions(identity, owner),
    record: (assignment: CodexNativeSubagentPendingAssignment) =>
      store.mutate(
        identity,
        {
          kind: "record-native-subagent-assignment",
          owner: historyOwner(),
          assignment,
        },
        () => {},
      ),
    rotate: (threadId: string) =>
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "parent-thread",
        binding: { ...binding, threadId },
      }),
    settle: async (client = createClient(), owner = historyOwner()) => {
      const parent = await register(client, owner);
      await parent.ready;
      await parent.unregister();
      return parent;
    },
    newBindingStore: () => createCodexAppServerBindingStore(state),
  };
}

export async function completeInForeground(client: ReturnType<typeof createClient>) {
  await client.completeTurn({
    status: "completed",
    items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Native result" }],
  });
  await client.item(
    collabItem("wait", ["child-thread"], {
      id: "wait",
      agentsStates: { "child-thread": { status: "completed", message: "Native result" } },
    }),
  );
}

export async function submitFollowup(client: ReturnType<typeof createClient>) {
  await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
  await client.notify(
    successfulSendInputOutput({ callId: "followup", submissionId: "followup-turn" }),
  );
}
