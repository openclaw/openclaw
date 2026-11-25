import { beforeEach, expect, it, vi } from "vitest";
import { clearSlackThreadParticipationCache } from "../../sent-thread-cache.js";
import {
  createSlackFailureNoticePolicy,
  createSlackQueuedFailureNoticePolicy,
} from "./failure-notice.js";

const params = {
  context: { ChatType: "channel", MentionSource: "implicit_thread" } as const,
  accountId: "default",
  channelId: "C1",
  failureNoticeThreadTs: "100.001",
  failureNoticeTeamId: "T1",
};
const failure = { text: "Request timed out", isError: true };
const beginRun = () => vi.fn();
beforeEach(() => clearSlackThreadParticipationCache());

it("shares outage notices across immediate and queued sends and resets after a healthy queued turn", () => {
  const direct = createSlackFailureNoticePolicy(params, () => false);
  expect(direct.filter(failure)).toBe(failure);
  direct.recordDelivered();
  const queued = createSlackQueuedFailureNoticePolicy(params, beginRun);
  let end = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(true);
  end?.({ visibleReplySent: false, failed: true });

  end = queued.begin();
  expect(queued.shouldSuppressReply?.({ text: "Recovered" })).toBe(false);
  queued.onReplyDelivered?.({ text: "Recovered" });
  end?.({ visibleReplySent: true, failed: false, completed: true });
  const next = createSlackFailureNoticePolicy(params, () => false);
  expect(next.filter(failure)).toBe(failure);
});

it("does not cache an unconfirmed send or clear an outage on pending delivery", () => {
  const queued = createSlackQueuedFailureNoticePolicy(params, beginRun);
  let end = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(false);
  end?.({ visibleReplySent: false, failed: true });
  end = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(false);
  queued.onReplyDelivered?.(failure);
  end?.({ visibleReplySent: true, failed: true });
  end = queued.begin();
  end?.({ visibleReplySent: false, failed: false, completed: true, transportPending: true });
  end = queued.begin();
  end?.({ visibleReplySent: false, failed: false, completed: false });
  queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(true);
});

it("keeps direct messages and other threads/workspaces independent", () => {
  const queued = createSlackQueuedFailureNoticePolicy(params, beginRun);
  const end = queued.begin();
  queued.shouldSuppressReply?.(failure);
  queued.onReplyDelivered?.(failure);
  end?.({ visibleReplySent: true, failed: true });
  for (const different of [
    { ...params, context: { ChatType: "direct" } },
    { ...params, failureNoticeThreadTs: "200.001" },
    { ...params, failureNoticeTeamId: "T2" },
  ]) {
    const next = createSlackQueuedFailureNoticePolicy(different, beginRun);
    next.begin();
    expect(next.shouldSuppressReply?.(failure)).toBe(false);
  }
});

it("does not mistake a delivered supplement for an undelivered failure notice", () => {
  const queued = createSlackQueuedFailureNoticePolicy(params, beginRun);
  const end = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(false);
  // The error send failed; only the later diagnostics supplement reached Slack.
  const supplement = { text: "Usage: 100 tokens" };
  expect(queued.shouldSuppressReply?.(supplement)).toBe(false);
  queued.onReplyDelivered?.(supplement);
  end?.({ visibleReplySent: true, failed: true });

  const nextEnd = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(false);
  queued.onReplyDelivered?.(failure);
  nextEnd?.({ visibleReplySent: true, failed: true });
  const finalEnd = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(true);
  finalEnd?.({ visibleReplySent: false, failed: true });
});
