import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { clearSlackThreadParticipationCache } from "../../sent-thread-cache.js";
import {
  createSlackFailureNoticePolicy,
  createSlackQueuedFailureNoticePolicy,
} from "./failure-notice.js";

const params = {
  cfg: {},
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
  const direct = createSlackFailureNoticePolicy(
    params,
    () => false,
    () => false,
  );
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
  const next = createSlackFailureNoticePolicy(
    params,
    () => false,
    () => false,
  );
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

const allowParams = {
  ...params,
  cfg: { agents: { defaults: { silentReply: { group: "allow" as const } } } },
};

it.each([
  { ChatType: "group", MentionSource: "none" as const },
  { MentionSource: "none" as const },
  { MentionSource: "mention_pattern" as const },
  { CommandTurn: { kind: "native", source: "native", authorized: false } as const },
  { MentionSource: "subteam" as const, ExplicitlyMentionedBot: true },
  { MentionSource: "implicit_thread" as const, ImplicitMentionKinds: ["bot_thread_participant"] },
  { MentionSource: "implicit_thread" as const, ImplicitMentionKinds: ["reply_to_bot"] },
  { MentionSource: "implicit_thread" as const, ImplicitMentionKinds: ["quoted_bot"] },
  { MentionSource: "implicit_thread" as const, ImplicitMentionKinds: ["native"] },
])("keeps unaddressed backend failures silent, including the first notice: %j", (addressing) => {
  const request = { ...allowParams, context: { ...allowParams.context, ...addressing } };
  const direct = createSlackFailureNoticePolicy(
    request,
    () => false,
    () => false,
  );
  const queued = createSlackQueuedFailureNoticePolicy(request, beginRun);
  const end = queued.begin();
  for (const payload of [failure, { text: "Authentication failed", isError: true }]) {
    expect(direct.filter(payload)).toBeNull();
    expect(queued.shouldSuppressReply?.(payload)).toBe(true);
  }
  end?.({ visibleReplySent: false, failed: true });
});

it.each([
  { ChatType: "channel", MentionSource: "explicit_bot" as const },
  { ChatType: "channel", ExplicitlyMentionedBot: true },
  { ChatType: "channel", MentionSource: "command_bypass" as const },
  {
    ChatType: "channel",
    CommandTurn: { kind: "native", source: "native", authorized: true } as const,
  },
  { ChatType: "direct" },
  { ChatType: "group", MentionSource: "explicit_bot" as const },
])("retains feedback for each direct request: %j", (context) => {
  const request = { ...allowParams, context };
  for (let index = 0; index < 2; index++) {
    expect(
      createSlackFailureNoticePolicy(
        request,
        () => false,
        () => false,
      ).filter(failure),
    ).toBe(failure);
    const queued = createSlackQueuedFailureNoticePolicy(request, beginRun);
    const end = queued.begin();
    expect(queued.shouldSuppressReply?.(failure)).toBe(false);
    queued.onReplyDelivered?.(failure);
    end?.({ visibleReplySent: true, failed: true });
  }
});

it.each<{ payload: ReplyPayload; useful: boolean }>([
  { payload: { text: "The requested result is ready" }, useful: true },
  { payload: { mediaUrl: "https://example.test/result.png" }, useful: true },
  { payload: { text: "Working", isCommentary: true }, useful: false },
  { payload: { text: "Thinking", isReasoning: true }, useful: false },
  { payload: { text: "Working", isStatusNotice: true }, useful: false },
  { payload: { text: "Retrying", isFallbackNotice: true }, useful: false },
])(
  "requires a useful confirmed reply before reporting an unaddressed failure: $payload",
  ({ payload, useful }) => {
    const queued = createSlackQueuedFailureNoticePolicy(allowParams, beginRun);
    const end = queued.begin();
    queued.onReplyDelivered?.(payload);
    expect(queued.shouldSuppressReply?.(failure)).toBe(!useful);
    end?.({ visibleReplySent: true, failed: true });
    const nextEnd = queued.begin();
    expect(queued.shouldSuppressReply?.(failure)).toBe(true);
    nextEnd?.({ visibleReplySent: false, failed: true });
  },
);

it("does not treat an unconfirmed answer or pending delivery as a useful reply", () => {
  const queued = createSlackQueuedFailureNoticePolicy(allowParams, beginRun);
  const end = queued.begin();
  expect(queued.shouldSuppressReply?.({ text: "Result" })).toBe(false);
  expect(queued.shouldSuppressReply?.(failure)).toBe(true);
  end?.({ visibleReplySent: false, failed: false, completed: true, transportPending: true });
  const nextEnd = queued.begin();
  expect(queued.shouldSuppressReply?.(failure)).toBe(true);
  nextEnd?.({ visibleReplySent: false, failed: true });
});

it("preserves ordinary answers and reports a failure after useful delivery", () => {
  const answer = { text: "The query returned three results" };
  expect(
    createSlackFailureNoticePolicy(
      allowParams,
      () => false,
      () => false,
    ).filter(answer),
  ).toBe(answer);
  expect(
    createSlackFailureNoticePolicy(
      allowParams,
      () => true,
      () => true,
    ).filter(failure),
  ).toBe(failure);
});

it("honors the Slack surface override while preserving disallow failure dedupe", () => {
  const disallowParams = {
    ...allowParams,
    cfg: {
      ...allowParams.cfg,
      surfaces: { slack: { silentReply: { group: "disallow" as const } } },
    },
  };
  const first = createSlackFailureNoticePolicy(
    disallowParams,
    () => false,
    () => false,
  );
  expect(first.filter(failure)).toBe(failure);
  first.recordDelivered();
  const next = createSlackFailureNoticePolicy(
    disallowParams,
    () => false,
    () => false,
  );
  expect(next.filter(failure)).toBeNull();
  const changed = { text: "Authentication failed", isError: true };
  expect(next.filter(changed)).toBe(changed);
});

it("uses the Slack allow override without changing unknown conversation behavior", () => {
  const surfaceAllow = {
    ...params,
    cfg: {
      agents: { defaults: { silentReply: { group: "disallow" as const } } },
      surfaces: { slack: { silentReply: { group: "allow" as const } } },
    },
  };
  expect(
    createSlackFailureNoticePolicy(
      surfaceAllow,
      () => false,
      () => false,
    ).filter(failure),
  ).toBeNull();
  const unknown = { ...surfaceAllow, context: { ...surfaceAllow.context, ChatType: undefined } };
  expect(
    createSlackFailureNoticePolicy(
      unknown,
      () => false,
      () => false,
    ).filter(failure),
  ).toBe(failure);
});
