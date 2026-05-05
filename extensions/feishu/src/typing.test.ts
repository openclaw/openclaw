import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";

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

import {
  addTypingIndicator,
  FeishuBackoffError,
  getBackoffCodeFromResponse,
  isFeishuBackoffError,
  removeTypingIndicator,
} from "./typing.js";

describe("isFeishuBackoffError", () => {
  it("returns true for HTTP 429 (AxiosError shape)", () => {
    const err = { response: { status: 429, data: {} } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu quota exceeded code 99991403", () => {
    const err = { response: { status: 200, data: { code: 99991403 } } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for Feishu rate limit code 99991400", () => {
    const err = { response: { status: 200, data: { code: 99991400 } } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with code 429", () => {
    const err = { code: 429, message: "too many requests" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns true for SDK error with top-level code 99991403", () => {
    const err = { code: 99991403, message: "quota exceeded" };
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("returns false for other HTTP errors (e.g. 500)", () => {
    const err = { response: { status: 500, data: {} } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for non-rate-limit Feishu codes", () => {
    const err = { response: { status: 200, data: { code: 99991401 } } };
    expect(isFeishuBackoffError(err)).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isFeishuBackoffError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFeishuBackoffError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFeishuBackoffError(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isFeishuBackoffError("429")).toBe(false);
  });

  it("returns true for 429 even without data", () => {
    const err = { response: { status: 429 } };
    expect(isFeishuBackoffError(err)).toBe(true);
  });
});

describe("getBackoffCodeFromResponse", () => {
  it("returns backoff code for response with quota exceeded code", () => {
    const response = { code: 99991403, msg: "quota exceeded", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with rate limit code", () => {
    const response = { code: 99991400, msg: "rate limit", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns backoff code for response with code 429", () => {
    const response = { code: 429, msg: "too many requests", data: null };
    expect(getBackoffCodeFromResponse(response)).toBe(response.code);
  });

  it("returns undefined for successful response (code 0)", () => {
    const response = { code: 0, msg: "success", data: { reaction_id: "r1" } };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for other error codes", () => {
    const response = { code: 99991401, msg: "other error", data: null };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getBackoffCodeFromResponse(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(getBackoffCodeFromResponse(undefined)).toBeUndefined();
  });

  it("returns undefined for response without code field", () => {
    const response = { data: { reaction_id: "r1" } };
    expect(getBackoffCodeFromResponse(response)).toBeUndefined();
  });
});

describe("FeishuBackoffError", () => {
  it("is detected by isFeishuBackoffError via .code property", () => {
    const err = new FeishuBackoffError(99991403);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("is detected for rate limit code 99991400", () => {
    const err = new FeishuBackoffError(99991400);
    expect(isFeishuBackoffError(err)).toBe(true);
  });

  it("has correct name and message", () => {
    const err = new FeishuBackoffError(99991403);
    expect(err.name).toBe("FeishuBackoffError");
    expect(err.message).toBe("Feishu API backoff: code 99991403");
    expect(err.code).toBe(99991403);
  });

  it("is an instance of Error", () => {
    const err = new FeishuBackoffError(99991403);
    expect(err instanceof Error).toBe(true);
  });

  it("survives catch-and-rethrow pattern", () => {
    let caught: unknown;
    try {
      try {
        throw new FeishuBackoffError(99991403);
      } catch (err) {
        if (isFeishuBackoffError(err)) {
          throw err;
        }
        caught = "swallowed";
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FeishuBackoffError);
  });
});

describe("typing indicator message id normalization", () => {
  const reactionCreateMock = vi.fn();
  const reactionDeleteMock = vi.fn();
  const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
  const cfg = {} as ClawdbotConfig;
  const syntheticMessageId = "om_dc132ca13c4c274d9a8d54aabfcafe00:reaction:thumbsup:uuid-1";
  const normalizedMessageId = "om_dc132ca13c4c274d9a8d54aabfcafe00";

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      configured: true,
      accountId: "default",
      appId: "app-id",
      appSecret: "secret",
    });
    createFeishuClientMock.mockReturnValue({
      im: {
        messageReaction: {
          create: reactionCreateMock,
          delete: reactionDeleteMock,
        },
      },
    });
    reactionCreateMock.mockResolvedValue({
      code: 0,
      data: { reaction_id: "typing-reaction-1" },
    });
    reactionDeleteMock.mockResolvedValue({ code: 0, data: {} });
  });

  it("normalizes synthetic reaction ids before adding typing indicators", async () => {
    const state = await addTypingIndicator({
      cfg,
      messageId: syntheticMessageId,
      runtime,
    });

    expect(reactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: normalizedMessageId },
      data: { reaction_type: { emoji_type: "Typing" } },
    });
    expect(state).toEqual({
      messageId: normalizedMessageId,
      reactionId: "typing-reaction-1",
    });
  });

  it("uses the normalized id again when removing typing indicators", async () => {
    await removeTypingIndicator({
      cfg,
      state: {
        messageId: normalizedMessageId,
        reactionId: "typing-reaction-1",
      },
      runtime,
    });

    expect(reactionDeleteMock).toHaveBeenCalledWith({
      path: {
        message_id: normalizedMessageId,
        reaction_id: "typing-reaction-1",
      },
    });
  });

  it("returns a normalized state even when the account is not configured", async () => {
    resolveFeishuRuntimeAccountMock.mockReturnValue({ configured: false });

    const state = await addTypingIndicator({
      cfg,
      messageId: syntheticMessageId,
      runtime,
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(state).toEqual({
      messageId: normalizedMessageId,
      reactionId: null,
    });
  });
});
