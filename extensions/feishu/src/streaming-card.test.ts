import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";

function installFetchMock(): void {
  fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return {
        response: {
          json: async () => ({ code: 0, tenant_access_token: "token", expire: 7200 }),
        },
        release: async () => {},
      };
    }
    return {
      response: {
        json: async () => ({ code: 0, msg: "ok", data: {} }),
      },
      release: async () => {},
    };
  });
}

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });
});

describe("FeishuStreamingSession.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetchMock();
  });

  it("supports replace mode to overwrite transient status text", async () => {
    const session = new FeishuStreamingSession({} as never, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.update("🔧 正在使用Read工具...", { mode: "replace" });

    expect(updateCardContentSpy).toHaveBeenCalledWith(
      "🔧 正在使用Read工具...",
      expect.any(Function),
    );
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});

describe("FeishuStreamingSession.close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetchMock();
  });

  it("treats explicit empty final text as authoritative", async () => {
    const session = new FeishuStreamingSession({} as never, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "💭 思考中...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close("");

    expect(updateCardContentSpy).toHaveBeenCalledWith("");
    expect((session as any).state.currentText).toBe("");
  });

  it("keeps pending merge behavior when final text is omitted", async () => {
    const session = new FeishuStreamingSession({} as never, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "第一段",
    };
    (session as any).pendingUpdate = { text: "第一段\n第二段", mode: "merge" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("第一段\n第二段");
    expect((session as any).state.currentText).toBe("第一段\n第二段");
  });

  it("respects pending replace updates when final text is omitted", async () => {
    const session = new FeishuStreamingSession({} as never, {
      appId: "app",
      appSecret: "secret",
    });
    (session as any).state = {
      cardId: "card-id",
      messageId: "message-id",
      sequence: 1,
      currentText: "💭 思考中...",
    };
    (session as any).pendingUpdate = { text: "🔧 正在使用Read工具...", mode: "replace" };
    const updateCardContentSpy = vi
      .spyOn(session as any, "updateCardContent")
      .mockResolvedValue(undefined);

    await session.close();

    expect(updateCardContentSpy).toHaveBeenCalledWith("🔧 正在使用Read工具...");
    expect((session as any).state.currentText).toBe("🔧 正在使用Read工具...");
  });
});
