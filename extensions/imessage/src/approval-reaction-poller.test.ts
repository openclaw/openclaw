import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import type { IMessagePayload } from "./monitor/types.js";
import { resolvedApproval } from "./test-support/approval.js";

let runtimeEnv: typeof import("openclaw/plugin-sdk/runtime-env");
let poll: typeof import("./approval-reaction-poller.js").pollPendingIMessageApprovalReactions;
let registerIMessageApprovalReactionTarget: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTarget;
let resolveIMessageApprovalReactionTargetWithPersistence: typeof import("./approval-reactions.js").resolveIMessageApprovalReactionTargetWithPersistence;

beforeEach(async () => {
  vi.resetModules();
  runtimeEnv = await import("openclaw/plugin-sdk/runtime-env");
  ({ pollPendingIMessageApprovalReactions: poll } = await import("./approval-reaction-poller.js"));
  ({
    registerIMessageApprovalReactionTarget,
    resolveIMessageApprovalReactionTargetWithPersistence,
  } = await import("./approval-reactions.js"));
});

const resolverMocks = vi.hoisted(() => ({ resolve: vi.fn() }));

type IMessageTargetParams = Parameters<typeof registerIMessageApprovalReactionTarget>[0];

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolve,
}));

function createRpcRequest(messages: unknown[], chatIds?: number[]) {
  return vi.fn(async (method: string) => {
    if (method === "chats.list" && chatIds) {
      return { chats: chatIds.map((id) => ({ id })) };
    }
    if (method === "messages.history") {
      return { messages };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

const APPROVER = "+15551230000";
const DEFAULT_CHAT_ID = 42;

const cfg = { channels: { imessage: { allowFrom: [APPROVER] } } };
function expectHistory(request: ReturnType<typeof vi.fn>) {
  expect(request).toHaveBeenCalledWith(
    "messages.history",
    { chat_id: DEFAULT_CHAT_ID, limit: 30 },
    { timeoutMs: 10_000 },
  );
}

const reaction = {
  id: 7,
  sender: APPROVER,
  type: "like",
  emoji: "👍",
  created_at: "2026-05-27T21:00:00.000Z",
};
function buildReaction(overrides: Partial<typeof reaction> & { is_from_me?: boolean } = {}) {
  return { ...reaction, ...overrides };
}

function buildApprovalMessage(
  overrides: IMessagePayload & { reactions?: ReturnType<typeof buildReaction>[] } = {},
) {
  return {
    guid: "msg-1",
    chat_id: DEFAULT_CHAT_ID,
    chat_guid: `SMS;-;${APPROVER}`,
    chat_identifier: APPROVER,
    is_from_me: true,
    sender: APPROVER,
    text: "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
    reactions: [buildReaction({ is_from_me: true })],
    ...overrides,
  };
}

function buildGroupApprovalMessage(
  reactions: ReturnType<typeof buildReaction>[] = [
    buildReaction({ id: 8, created_at: "2026-05-27T21:01:00.000Z" }),
    buildReaction({ id: 9, type: "dislike", emoji: "👎", created_at: "2026-05-27T21:02:00.000Z" }),
  ],
) {
  return buildApprovalMessage({
    chat_guid: "iMessage;+;chat-guid",
    chat_identifier: undefined,
    is_group: true,
    sender: undefined,
    text: "Exec approval required\nID: exec-1",
    reactions,
  });
}

describe("iMessage approval reaction poller", () => {
  let accountSequence = 0;
  let accountId = "";
  const conversation = { chatId: DEFAULT_CHAT_ID, chatGuid: "iMessage;+;chat-guid" };
  function resolveTarget() {
    return resolveIMessageApprovalReactionTargetWithPersistence({
      accountId,
      conversation,
      messageId: "msg-1",
      reactionKey: "👍",
    });
  }
  function expectResolution() {
    expect(resolverMocks.resolve).toHaveBeenCalledWith({
      accountId,
      cfg,
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "imessage",
      senderId: APPROVER,
      gatewayUrl: undefined,
    });
  }

  type PollParams = Parameters<typeof poll>[0];

  function buildPollParams(
    request: ReturnType<typeof vi.fn>,
    overrides: Partial<Omit<PollParams, "client" | "accountId">> = {},
  ): PollParams {
    return { client: { request } as unknown as IMessageRpcClient, cfg, accountId, ...overrides };
  }

  function registerTarget(
    overrides: Partial<Omit<IMessageTargetParams, "accountId" | "approvalKind">> = {},
  ) {
    return registerIMessageApprovalReactionTarget({
      accountId,
      conversation,
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
      approvalKind: "exec",
      ...overrides,
    });
  }

  beforeEach(() => {
    accountSequence += 1;
    accountId = `test-${accountSequence}`;
    resolverMocks.resolve.mockReset().mockImplementation(resolvedApproval);
  });

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

  it("discovers typed handle-only targets through recent chat history", async () => {
    await registerTarget({ conversation: { handle: APPROVER } });
    const request = createRpcRequest([buildApprovalMessage()], [DEFAULT_CHAT_ID]);

    await poll(buildPollParams(request, { allowRecentChatDiscovery: true }));

    expect(request).toHaveBeenCalledWith("chats.list", { limit: 50 }, { timeoutMs: 10_000 });
    expectHistory(request);
    expectResolution();
  });

  it("uses learned chat ids for fast scoped polling after discovery", async () => {
    await registerTarget({ conversation: { handle: APPROVER } });
    await registerTarget({ conversation: { chatId: 42, chatGuid: `SMS;-;${APPROVER}` } });
    const request = createRpcRequest([]);

    await poll(buildPollParams(request));

    expect(request).toHaveBeenCalledTimes(1);
    expectHistory(request);
  });

  it("continues scanning after an unauthorized reaction leaves the approval pending", async () => {
    await registerTarget();
    const request = createRpcRequest([
      buildGroupApprovalMessage([
        buildReaction({ id: 8, sender: "+15550000000", created_at: "2026-05-27T21:01:00.000Z" }),
        buildReaction({ id: 9, created_at: "2026-05-27T21:02:00.000Z" }),
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
    const logVerboseMessage = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
    onTestFinished(() => logVerboseMessage.mockRestore());
    const pollParams = buildPollParams(request);

    await poll(pollParams);
    await poll(pollParams);

    expect(resolverMocks.resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "imessage: approval reaction already resolved id=exec-1 sender=+15551230000 status=denied decision=deny reason=user via messageId=msg-1",
    );
    expect(logVerboseMessage.mock.calls.flat().join(" ")).not.toContain("decision=allow-once");
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
});
