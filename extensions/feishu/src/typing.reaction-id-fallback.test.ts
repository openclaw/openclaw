import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const shouldLogVerboseMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    logging: {
      shouldLogVerbose: shouldLogVerboseMock,
    },
  }),
}));

import { addTypingIndicator, FeishuBackoffError } from "./typing.js";

function createMockClient(options?: { createResponse?: unknown; listResponse?: unknown }) {
  return {
    im: {
      messageReaction: {
        create: vi.fn(
          async () => options?.createResponse ?? { code: 0, data: { reaction_id: "rxn_direct" } },
        ),
        list: vi.fn(async () => options?.listResponse ?? { code: 0, data: { items: [] } }),
      },
    },
  };
}

describe("addTypingIndicator reaction-id fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      configured: true,
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });
  });

  it("returns direct reaction_id from create response without list lookup", async () => {
    const client = createMockClient({
      createResponse: { code: 0, data: { reaction_id: "rxn_direct" } },
    });
    createFeishuClientMock.mockReturnValue(client);

    const result = await addTypingIndicator({
      cfg: {} as never,
      messageId: "om_1",
      accountId: "main",
    });

    expect(result).toEqual({ messageId: "om_1", reactionId: "rxn_direct" });
    expect(client.im.messageReaction.create).toHaveBeenCalledTimes(1);
    expect(client.im.messageReaction.list).not.toHaveBeenCalled();
  });

  it("falls back to list and matches by botOpenId when create omits reaction_id", async () => {
    const client = createMockClient({
      createResponse: { code: 0, data: {} },
      listResponse: {
        code: 0,
        data: {
          items: [
            { reaction_id: "rxn_user", operator_type: "user", operator_id: { open_id: "ou_user" } },
            {
              reaction_id: "rxn_other",
              operator_type: "app",
              operator_id: { open_id: "ou_other_bot" },
            },
            {
              reaction_id: "rxn_self",
              operator_type: "app",
              operator_id: { open_id: "ou_self_bot" },
            },
          ],
        },
      },
    });
    createFeishuClientMock.mockReturnValue(client);

    const result = await addTypingIndicator({
      cfg: {} as never,
      messageId: "om_2",
      accountId: "main",
      botOpenId: "ou_self_bot",
    });

    expect(result).toEqual({ messageId: "om_2", reactionId: "rxn_self" });
    expect(client.im.messageReaction.list).toHaveBeenCalledWith({
      path: { message_id: "om_2" },
      params: { reaction_type: "Typing" },
    });
  });

  it("uses unique app reaction when botOpenId is unavailable", async () => {
    const client = createMockClient({
      createResponse: { code: 0, data: {} },
      listResponse: {
        code: 0,
        data: {
          items: [
            { reaction_id: "rxn_user", operator_type: "user", operator_id: { open_id: "ou_user" } },
            {
              reaction_id: "rxn_app_only",
              operator_type: "app",
              operator_id: { open_id: "ou_app" },
            },
          ],
        },
      },
    });
    createFeishuClientMock.mockReturnValue(client);

    const result = await addTypingIndicator({
      cfg: {} as never,
      messageId: "om_3",
      accountId: "main",
    });

    expect(result).toEqual({ messageId: "om_3", reactionId: "rxn_app_only" });
  });

  it("returns null reactionId when fallback list has multiple app reactions and no botOpenId", async () => {
    const client = createMockClient({
      createResponse: { code: 0, data: {} },
      listResponse: {
        code: 0,
        data: {
          items: [
            {
              reaction_id: "rxn_app_a",
              operator_type: "app",
              operator_id: { open_id: "ou_app_a" },
            },
            {
              reaction_id: "rxn_app_b",
              operator_type: "app",
              operator_id: { open_id: "ou_app_b" },
            },
          ],
        },
      },
    });
    createFeishuClientMock.mockReturnValue(client);

    const result = await addTypingIndicator({
      cfg: {} as never,
      messageId: "om_4",
      accountId: "main",
    });

    expect(result).toEqual({ messageId: "om_4", reactionId: null });
  });

  it("re-throws backoff from list fallback", async () => {
    const client = createMockClient({
      createResponse: { code: 0, data: {} },
      listResponse: { code: 99991403, msg: "quota exceeded", data: null },
    });
    createFeishuClientMock.mockReturnValue(client);

    await expect(
      addTypingIndicator({
        cfg: {} as never,
        messageId: "om_5",
        accountId: "main",
      }),
    ).rejects.toBeInstanceOf(FeishuBackoffError);
  });
});
