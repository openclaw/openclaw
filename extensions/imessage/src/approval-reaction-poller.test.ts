import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { resolvedApproval } from "./test-support/approval.js";

let poll: typeof import("./approval-reaction-poller.js").pollPendingIMessageApprovalReactions;
let targets: typeof import("./approval-reactions.js");

beforeEach(async () => {
  vi.resetModules();
  ({ pollPendingIMessageApprovalReactions: poll } = await import("./approval-reaction-poller.js"));
  targets = await import("./approval-reactions.js");
  accountSequence += 1;
  accountId = `test-${accountSequence}`;
  resolverMocks.resolve.mockReset().mockImplementation(resolvedApproval);
});

const resolverMocks = vi.hoisted(() => ({ resolve: vi.fn() }));

type TargetParams = Parameters<typeof targets.registerIMessageApprovalReactionTarget>[0];

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolve,
}));

function createRpcRequest(messages: unknown[], chatIds?: number[]) {
  return vi.fn(async (method: string, params?: { chat_id?: number }) => {
    if (method === "chats.list" && chatIds) {
      return { chats: chatIds.map((id) => ({ id })) };
    }
    if (method === "messages.history" && params?.chat_id === DEFAULT_CHAT_ID) {
      return { messages };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

const APPROVER = "+15551230000";
const DEFAULT_CHAT_ID = 42;

const cfg = { channels: { imessage: { allowFrom: [APPROVER] } } };
const reaction = {
  id: 7,
  sender: APPROVER,
  type: "like",
  emoji: "👍",
  created_at: "2026-05-27T21:00:00.000Z",
};
type Reaction = typeof reaction & { is_from_me?: boolean };

function buildGroupApprovalMessage(
  reactions: Reaction[] = [
    { ...reaction, id: 8, created_at: "2026-05-27T21:01:00.000Z" },
    { ...reaction, id: 9, type: "dislike", emoji: "👎", created_at: "2026-05-27T21:02:00.000Z" },
  ],
) {
  return {
    guid: "msg-1",
    chat_id: DEFAULT_CHAT_ID,
    chat_guid: "iMessage;+;chat-guid",
    is_group: true,
    reactions,
  };
}

let accountSequence = 0;
let accountId = "";
const conversation = { chatId: DEFAULT_CHAT_ID, chatGuid: "iMessage;+;chat-guid" };
function resolveTarget() {
  return targets.resolveIMessageApprovalReactionTargetWithPersistence({
    accountId,
    conversation,
    messageId: "msg-1",
    reactionKey: "👍",
  });
}
function expectResolution() {
  expect(resolverMocks.resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId,
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: APPROVER,
    }),
  );
}

type PollParams = Parameters<typeof poll>[0];

function buildPollParams(
  request: ReturnType<typeof vi.fn>,
  overrides: Partial<Omit<PollParams, "client" | "accountId">> = {},
): PollParams {
  return { client: { request } as unknown as IMessageRpcClient, cfg, accountId, ...overrides };
}

function registerTarget(overrides: Partial<Omit<TargetParams, "accountId" | "approvalKind">> = {}) {
  return targets.registerIMessageApprovalReactionTarget({
    accountId,
    conversation,
    messageId: "msg-1",
    approvalId: "exec-1",
    allowedDecisions: ["allow-once", "deny"],
    approvalKind: "exec",
    ...overrides,
  });
}

it("does not resolve reactions from a history response after its account retires", async () => {
  await registerTarget();
  const history = createDeferred<{ messages: ReturnType<typeof buildGroupApprovalMessage>[] }>();
  const requested = createDeferred<void>();
  const request = vi.fn(() => {
    requested.resolve();
    return history.promise;
  });
  const controller = new AbortController();
  const polling = poll(buildPollParams(request, { signal: controller.signal }));
  await requested.promise;
  controller.abort();
  history.resolve({ messages: [buildGroupApprovalMessage()] });
  await polling;
  expect(resolverMocks.resolve).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it("discovers a handle target, then polls its learned chat without discovery", async () => {
  await registerTarget({ conversation: { handle: APPROVER } });
  const message = {
    guid: "msg-1",
    chat_id: DEFAULT_CHAT_ID,
    chat_guid: `SMS;-;${APPROVER}`,
    chat_identifier: APPROVER,
    is_from_me: true,
    sender: APPROVER,
    reactions: [] as Reaction[],
  };
  const request = createRpcRequest([message], [DEFAULT_CHAT_ID]);

  await poll(buildPollParams(request, { allowRecentChatDiscovery: true }));

  expect(request.mock.calls.map(([method]) => method)).toEqual(["chats.list", "messages.history"]);
  expect(resolverMocks.resolve).not.toHaveBeenCalled();
  request.mockClear();
  message.reactions.push({ ...reaction, is_from_me: true });
  await poll(buildPollParams(request));
  expect(request).toHaveBeenCalledTimes(1);
  expectResolution();
});

it("continues scanning after an unauthorized reaction leaves the approval pending", async () => {
  await registerTarget();
  const request = createRpcRequest([
    buildGroupApprovalMessage([
      { ...reaction, id: 8, sender: "+15550000000", created_at: "2026-05-27T21:01:00.000Z" },
      { ...reaction, id: 9, created_at: "2026-05-27T21:02:00.000Z" },
    ]),
  ]);

  await poll(buildPollParams(request));

  expect(resolverMocks.resolve).toHaveBeenCalledTimes(1);
  expectResolution();
});

it("stops polling after another surface records the canonical winner", async () => {
  resolverMocks.resolve.mockResolvedValueOnce({
    applied: false,
    approval: { status: "denied", decision: "deny", reason: "user" },
  });
  await registerTarget();
  const request = createRpcRequest([buildGroupApprovalMessage()]);
  const pollParams = buildPollParams(request);

  await poll(pollParams);
  await poll(pollParams);

  expect(resolverMocks.resolve).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});

it("propagates an authorized resolver failure and retries it on the next poll", async () => {
  resolverMocks.resolve.mockRejectedValueOnce(new Error("gateway down"));
  await registerTarget();
  const request = createRpcRequest([buildGroupApprovalMessage()]);
  const pollParams = buildPollParams(request);

  // Preserve first-answer ordering across the monitor's next-interval retry.
  await expect(poll(pollParams)).rejects.toThrow("gateway down");
  expect(resolverMocks.resolve).toHaveBeenCalledTimes(1);
  expectResolution();
  await expect(resolveTarget()).resolves.toBeTruthy();

  // The later 👎 must never reach the resolver after the retried 👍 wins.
  await poll(pollParams);
  expect(resolverMocks.resolve).toHaveBeenCalledTimes(2);
  expect(resolverMocks.resolve.mock.calls[1]?.[0]).toEqual(
    resolverMocks.resolve.mock.calls[0]?.[0],
  );
  await expect(resolveTarget()).resolves.toBeNull();
});
