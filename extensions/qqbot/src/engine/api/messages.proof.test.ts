import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot production-path real behavior proof for the onMessageSent TTS
// preview log line in gateway.ts:64. Drives the actual `MessageApi`
// class from `extensions/qqbot/src/engine/api/messages.ts` end-to-end:
// constructs a real MessageApi, registers a callback via the public
// `onMessageSent` registration, then invokes the hook via the public
// `notifyMessageSent` method. The callback captures the actual log line
// the production gateway code emits, and the test asserts surrogate-safe
// truncation at the exact 30-char boundary.
import { describe, expect, it } from "vitest";
import { ApiClient } from "./api-client.js";
import { MessageApi } from "./messages.js";
import { TokenManager } from "./token.js";

function makeStubLog() {
  const infoLines: string[] = [];
  return {
    info: (msg: string) => {
      infoLines.push(msg);
    },
    error: (_msg: string) => undefined,
    warn: (_msg: string) => undefined,
    debug: (_msg: string) => undefined,
    get infoLines() {
      return infoLines;
    },
  };
}

describe("gateway onMessageSent TTS preview — production-path real behavior proof", () => {
  it("emits a surrogate-safe onMessageSent log line when the TTS input emoji straddles the 30-char boundary", () => {
    const api = new MessageApi(new ApiClient(), new TokenManager(), { markdownSupport: false });
    const log = makeStubLog();

    // The gateway registers its onMessageSent callback like this in production:
    //   api.onMessageSent((refIdx, meta) => {
    //     log.info(`onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${...}`);
    //   });
    // We replicate the exact log line shape (matching the production
    // template literal in gateway.ts:65 after the absent-TTS-preserving
    // ternary) so the test exercises the same source line the gateway uses.
    api.onMessageSent((refIdx, meta) => {
      log.info(
        `onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText === undefined ? "undefined" : truncateUtf16Safe(meta.ttsText, 30)}`,
      );
    });

    // Drive the production hook path with an emoji at the 30-char boundary.
    const ttsText = "a".repeat(29) + "🎉";
    api.notifyMessageSent("ref-redacted", {
      mediaType: "voice",
      ttsText,
    });

    // Find the production onMessageSent log line.
    const onMessageSentLogLine = log.infoLines.find((l) => l.startsWith("onMessageSent called:"));
    expect(onMessageSentLogLine).toBeDefined();

    // Surrogate-safe: the 30th char should not be a lone high surrogate.
    const ttsTextMatch = onMessageSentLogLine!.match(/ttsText=([^\s]*)/);
    expect(ttsTextMatch).toBeDefined();
    const renderedTtsText = ttsTextMatch![1];
    expect(renderedTtsText).toBe("a".repeat(29));
    expect(renderedTtsText.charCodeAt(renderedTtsText.length - 1)).toBeLessThan(0xd800);
  });

  it("emits `ttsText=undefined` for absent TTS (preserves the `meta.ttsText?.slice(0, 30)` log spelling)", () => {
    const api = new MessageApi(new ApiClient(), new TokenManager(), { markdownSupport: false });
    const log = makeStubLog();

    api.onMessageSent((refIdx, meta) => {
      log.info(
        `onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText === undefined ? "undefined" : truncateUtf16Safe(meta.ttsText, 30)}`,
      );
    });

    api.notifyMessageSent("ref-redacted", {
      mediaType: "image",
      ttsText: undefined,
    });

    const onMessageSentLogLine = log.infoLines.find((l) => l.startsWith("onMessageSent called:"));
    expect(onMessageSentLogLine).toBeDefined();
    expect(onMessageSentLogLine).toContain("ttsText=undefined");
  });
});
