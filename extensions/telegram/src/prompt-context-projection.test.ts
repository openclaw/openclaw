import { describe, expect, it } from "vitest";
import {
  parseTelegramPromptContextProjection,
  resolveCompleteTelegramPromptContextProjectionIds,
  resolveTelegramPromptContextSource,
  withTelegramPromptContextSource,
  type TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";

const source = { transcriptMessageId: "assistant-1" };

function completeIds(markers: TelegramPromptContextProjectionMarker[]) {
  return resolveCompleteTelegramPromptContextProjectionIds(markers);
}

describe("Telegram prompt-context projections", () => {
  it("round-trips a valid transcript source through channel data", () => {
    const payload = withTelegramPromptContextSource({ text: "hello" }, source);
    expect(resolveTelegramPromptContextSource(payload)).toEqual(source);
  });

  it("rejects stale transcript provenance after a whitespace-only text rewrite", () => {
    const payload = withTelegramPromptContextSource({ text: "hello" }, source);
    expect(resolveTelegramPromptContextSource({ ...payload, text: "hello " })).toBeUndefined();
  });

  it("parses valid markers and keeps invalid markers scoped to their transcript", () => {
    expect(parseTelegramPromptContextProjection(undefined)).toBeUndefined();
    expect(
      parseTelegramPromptContextProjection({ ...source, partIndex: -1, finalPart: true }),
    ).toEqual({ kind: "invalid", transcriptMessageId: source.transcriptMessageId });
    expect(
      parseTelegramPromptContextProjection({ ...source, partIndex: 0, finalPart: true }),
    ).toEqual({
      kind: "valid",
      projection: { ...source, partIndex: 0, finalPart: true },
    });
  });

  it("accepts one complete contiguous multipart projection", () => {
    expect(
      completeIds([
        { kind: "valid", projection: { ...source, partIndex: 0, finalPart: false } },
        { kind: "valid", projection: { ...source, partIndex: 1, finalPart: true } },
      ]),
    ).toEqual(new Set([source.transcriptMessageId]));
  });

  it("poisons one transcript identity when any marker for it is malformed", () => {
    expect(
      completeIds([
        { kind: "valid", projection: { ...source, partIndex: 0, finalPart: true } },
        { kind: "invalid", transcriptMessageId: source.transcriptMessageId },
      ]),
    ).toEqual(new Set());
  });
});
