import { describe, expect, it } from "vitest";
import {
  allocateTelegramDraftId,
  normalizeDraftText,
  resolveSendMessageDraftApi,
  TELEGRAM_NATIVE_DRAFT_MAX_CHARS,
} from "./native-draft-api.js";

describe("resolveSendMessageDraftApi", () => {
  it("returns undefined when sendMessageDraft is not on the api object", () => {
    expect(resolveSendMessageDraftApi({} as never)).toBeUndefined();
  });

  it("returns undefined when sendMessageDraft is not a function", () => {
    expect(resolveSendMessageDraftApi({ sendMessageDraft: "not-a-fn" } as never)).toBeUndefined();
  });

  it("returns a bound function when sendMessageDraft exists", () => {
    const fn = async () => {};
    const api = { sendMessageDraft: fn };
    const resolved = resolveSendMessageDraftApi(api as never);
    expect(resolved).toBeDefined();
    expect(typeof resolved).toBe("function");
  });
});

describe("allocateTelegramDraftId", () => {
  it("returns incrementing non-zero ids", () => {
    const id1 = allocateTelegramDraftId();
    const id2 = allocateTelegramDraftId();
    expect(id1).toEqual(expect.any(Number));
    expect(id1).not.toBe(0);
    expect(id2).toBe(id1 + 1);
  });
});

describe("normalizeDraftText", () => {
  it("trims trailing whitespace", () => {
    expect(normalizeDraftText("hello  ")).toBe("hello");
  });

  it("truncates to 4096 chars", () => {
    const long = "x".repeat(TELEGRAM_NATIVE_DRAFT_MAX_CHARS + 100);
    const result = normalizeDraftText(long);
    expect(result.length).toBe(TELEGRAM_NATIVE_DRAFT_MAX_CHARS);
  });

  it("returns short text unchanged", () => {
    expect(normalizeDraftText("short")).toBe("short");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeDraftText("   ")).toBe("");
  });
});
