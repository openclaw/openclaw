// Qqbot production-path real-behavior proof for the onDeliver log line in
// streaming-c2c.ts:546. Drives the actual `StreamingController.onDeliver`
// method end-to-end with a stubbed log object so the test can capture the
// real log line the production code emits, and asserts surrogate-safe
// truncation at the exact 60-char boundary.
import { describe, expect, it } from "vitest";
import { StreamingController } from "./streaming-c2c.js";

function makeStubLog() {
  const debugLines: string[] = [];
  return {
    info: (_msg: string) => undefined,
    error: (_msg: string) => undefined,
    warn: (_msg: string) => undefined,
    debug: (msg: string) => {
      debugLines.push(msg);
    },
    get debugLines() {
      return debugLines;
    },
  };
}

describe("streaming-c2c onDeliver log line — production-path real behavior proof", () => {
  it("emits a surrogate-safe onDeliver preview when the input emoji straddles the 60-char boundary", async () => {
    const log = makeStubLog();
    const controller = new StreamingController({
      account: {} as never,
      userId: "user-redacted",
      replyToMsgId: "msg-redacted",
      eventId: "evt-redacted",
      log,
    });

    // Drive the production onDeliver path with an emoji at the 60-char boundary.
    const input = "a".repeat(59) + "🎉";
    await controller.onDeliver({ text: input });

    // Find the production onDeliver log line (the production logDebug prefixes
    // the message with "[qqbot:streaming] ", so look for "onDeliver:" substring
    // rather than startsWith).
    const onDeliverLogLine = log.debugLines.find((l) => l.includes(" onDeliver: rawLen="));
    expect(onDeliverLogLine).toBeDefined();

    // Surrogate-safe: the 32nd-tail should be ASCII (no lone high surrogate).
    const previewMatch = onDeliverLogLine!.match(/preview="([^"]*)"/);
    expect(previewMatch).toBeDefined();
    const preview = previewMatch![1];
    expect(preview).toBe("a".repeat(59));
    expect(preview.charCodeAt(preview.length - 1)).toBeLessThan(0xd800);
  });

  it("emits a verbatim onDeliver preview for short ASCII input (no regression)", async () => {
    const log = makeStubLog();
    const controller = new StreamingController({
      account: {} as never,
      userId: "user-redacted",
      replyToMsgId: "msg-redacted",
      eventId: "evt-redacted",
      log,
    });

    await controller.onDeliver({ text: "hello world" });

    const onDeliverLogLine = log.debugLines.find((l) => l.includes(" onDeliver: rawLen="));
    expect(onDeliverLogLine).toBeDefined();
    expect(onDeliverLogLine).toContain('preview="hello world"');
  });
});
