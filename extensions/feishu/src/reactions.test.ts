import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.hoisted(() => vi.fn());

// mock-isolation: Exercise reaction pagination with a synthetic configured account.
vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: () => ({ configured: true }),
}));

// mock-isolation: Supply fixed API pages without creating an authenticated Feishu client.
vi.mock("./client.js", () => ({
  createFeishuClient: () => ({ im: { messageReaction: { list: listMock } } }),
}));

import { listReactionsFeishu } from "./reactions.js";

function list(emojiType?: string) {
  return listReactionsFeishu({ cfg: {}, messageId: "om_message", emojiType });
}
type Operator = { operator_type: string; operator_id: string };
function item(id: string, emoji: string, operator?: Operator) {
  return { reaction_id: id, reaction_type: { emoji_type: emoji }, operator };
}
function reaction(reactionId: string, emojiType: string, operatorType: string, operatorId: string) {
  return { reactionId, emojiType, operatorType, operatorId };
}
function page(items: ReturnType<typeof item>[] = [], more?: string | true) {
  return {
    code: 0,
    data: {
      items,
      has_more: Boolean(more),
      ...(typeof more === "string" ? { page_token: more } : {}),
    },
  };
}

describe("listReactionsFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockReset();
  });

  it("fails closed for missing or unrecognized operator metadata", async () => {
    listMock.mockResolvedValue(
      page([
        item("r-missing", "THUMBSUP"),
        item("r-unknown", "HEART", { operator_type: "tenant", operator_id: "tenant-1" }),
      ]),
    );

    expect(await list()).toEqual([
      reaction("r-missing", "THUMBSUP", "unknown", ""),
      reaction("r-unknown", "HEART", "unknown", "tenant-1"),
    ]);
  });

  it("drains every reaction page while retaining the requested emoji filter", async () => {
    listMock
      .mockResolvedValueOnce(
        page(
          [item("r-first", "HEART", { operator_type: "user", operator_id: "ou_user" })],
          "page-2",
        ),
      )
      .mockResolvedValueOnce(
        page([item("r-bot", "HEART", { operator_type: "app", operator_id: "cli_main" })]),
      );

    expect(await list("HEART")).toEqual([
      reaction("r-first", "HEART", "user", "ou_user"),
      reaction("r-bot", "HEART", "app", "cli_main"),
    ]);
    expect(listMock).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART" },
    });
    expect(listMock).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART", page_token: "page-2" },
    });
  });

  it.each([
    [undefined, /page token/i, 1],
    ["same-page", /repeated page token/i, 2],
  ])("rejects invalid continuation token %s", async (token, error, calls) => {
    listMock.mockResolvedValue(page([], token ?? true));
    await expect(list()).rejects.toThrow(error);
    expect(listMock).toHaveBeenCalledTimes(calls);
  });

  it("propagates API failures from continuation pages", async () => {
    listMock
      .mockResolvedValueOnce(page([], "page-2"))
      .mockResolvedValueOnce({ code: 9999, msg: "continuation unavailable" });

    await expect(list()).rejects.toThrow("Feishu list reactions failed: continuation unavailable");
  });
});
