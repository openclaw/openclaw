import path from "node:path";
import { isCodexAppServerClientRuntimeLive } from "./client-runtime.js";
import { readThreadParentThreadId } from "./native-subagent-assignment.js";
import type { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import type {
  ChildState,
  KnownChild,
  NativeSubagentMonitorClient,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import {
  hasUniqueOwnedChildResult,
  readOwnedNativeCompletionFacts,
  selectOwnedNativeCompletionReceipts,
} from "./native-subagent-owned-receipts.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
} from "./protocol.js";

export type ReceiptObservation = {
  deadlineAt: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  assertCurrentAsync: () => Promise<void>;
};

/** Observes durable consumption before releasing existing custody; it never executes a turn. */
export async function reconcileOwnedNativeCompletionReceipts(params: {
  client: NativeSubagentMonitorClient;
  state: ParentState;
  owner: ParentOwner;
  children: ReadonlyMap<string, ChildState>;
  knownChildren: ReadonlyMap<string, KnownChild>;
  isCurrent: () => boolean;
  delivery: Pick<CodexNativeSubagentCompletionDelivery, "applyReceipts">;
  observation: ReceiptObservation;
}): Promise<void> {
  const { client, state, owner, children, knownChildren, observation } = params;
  const identity = client.getRuntimeIdentity();
  const identityKey = JSON.stringify(identity);
  const home = identity?.codexHome;
  const pid = client.getTransportPid();
  // Duplex/remote transports have no local PID. Never interpret their home locally.
  if (
    !owner.turnId ||
    !home ||
    !path.isAbsolute(home) ||
    !Number.isSafeInteger(pid) ||
    !pid ||
    pid <= 0
  ) {
    return;
  }
  const assertCurrent = () => {
    observation.assertCurrent();
    if (
      observation.signal.aborted ||
      !params.isCurrent() ||
      !isCodexAppServerClientRuntimeLive(client) ||
      JSON.stringify(client.getRuntimeIdentity()) !== identityKey ||
      client.getTransportPid() !== pid ||
      performance.now() >= observation.deadlineAt
    ) {
      throw new Error("Native receipt observation is no longer current");
    }
    state.submissionStore?.assertCurrent();
  };
  assertCurrent();
  const candidates = [];
  for (const child of children.values()) {
    const known = knownChildren.get(child.childThreadId);
    if (
      child.parentThreadId !== state.parentThreadId ||
      child.nativeParentThreadId !== state.parentThreadId ||
      known?.parent !== state ||
      !child.nativeTurnId ||
      !child.pendingCompletion ||
      child.nativeCompletionDelivered ||
      (child.completionCustody && !child.completionCustody.isCurrent())
    ) {
      continue;
    }
    try {
      assertHistoryOwnerMatchesRegistration(
        child.historyOwner,
        state.historyOwner,
        child.nativeParentThreadId,
        true,
      );
    } catch {
      continue;
    }
    candidates.push({
      child,
      runId: child.runId,
      childThreadId: child.childThreadId,
      nativeTurnId: child.nativeTurnId,
      result: child.pendingCompletion.result,
      pendingCompletion: child.pendingCompletion,
      tracker: child.deliveryReceipts,
      agentPaths: [...known.agentPaths],
      uniqueResultProven: false,
    });
  }
  if (!candidates.length) {
    return;
  }
  const request = async <Method extends CodexAppServerRequestMethod>(
    method: Method,
    requestParams: CodexAppServerRequestParams<Method>,
  ): Promise<CodexAppServerRequestResult<Method>> => {
    assertCurrent();
    const response = await client.request(method, requestParams, {
      signal: observation.signal,
      timeoutMs: Math.max(1, Math.floor(observation.deadlineAt - performance.now())),
    });
    await observation.assertCurrentAsync();
    assertCurrent();
    return response;
  };
  const response = await request("thread/read", {
    threadId: state.parentThreadId,
    includeTurns: false,
  });
  if (response.thread.id !== state.parentThreadId || !response.thread.path) {
    return;
  }
  // Snapshot consumption first: later native output cannot enter after uniqueness was proved.
  const facts = await readOwnedNativeCompletionFacts({
    sessionsRoot: path.join(home, "sessions"),
    rolloutPath: response.thread.path,
    parentThreadId: state.parentThreadId,
    turnId: owner.turnId,
    deadlineAt: observation.deadlineAt,
    assertCurrent,
  });
  await observation.assertCurrentAsync();
  assertCurrent();
  if (!facts) {
    return;
  }
  for (const candidate of candidates) {
    const childResponse = await request("thread/read", {
      threadId: candidate.childThreadId,
      includeTurns: false,
    });
    if (
      childResponse.thread.id !== candidate.childThreadId ||
      readThreadParentThreadId(childResponse.thread) !== state.parentThreadId
    ) {
      continue;
    }
    const turns = await request("thread/turns/list", {
      threadId: candidate.childThreadId,
      limit: 64,
      sortDirection: "asc",
      itemsView: "full",
    });
    candidate.uniqueResultProven = hasUniqueOwnedChildResult(candidate, turns);
  }
  await observation.assertCurrentAsync();
  assertCurrent();
  for (const { candidate, notification } of selectOwnedNativeCompletionReceipts(
    facts,
    candidates,
  )) {
    assertCurrent();
    const child = children.get(candidate.runId);
    const known = knownChildren.get(candidate.childThreadId);
    if (
      child !== candidate.child ||
      child.nativeTurnId !== candidate.nativeTurnId ||
      child.pendingCompletion !== candidate.pendingCompletion ||
      child.pendingCompletion.result !== candidate.result ||
      child.deliveryReceipts !== candidate.tracker ||
      (child.completionCustody && !child.completionCustody.isCurrent()) ||
      known?.parent !== state
    ) {
      continue;
    }
    assertHistoryOwnerMatchesRegistration(
      child.historyOwner,
      state.historyOwner,
      child.nativeParentThreadId,
      true,
    );
    params.delivery.applyReceipts(
      state,
      child.deliveryReceipts.acknowledgeOwnedReceipt(
        candidate.runId,
        notification,
        state.parentThreadId,
        owner.turnId,
      ),
    );
  }
}
