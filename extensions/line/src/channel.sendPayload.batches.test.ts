// Line batch tests cover mixed provider payload behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createRuntime } from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import { setLineRuntime } from "./runtime.js";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

beforeEach(() => {
  vi.setSystemTime(1_800_000_000_000);
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("line outbound sendPayload batches", () => {
  it("publishes a single receipt for a mixed Flex payload", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const result = await lineOutboundAdapter.sendText!({
      to: "line:user:U123",
      text: "```js\nfirst()\n```\n\n```js\nsecond()\n```",
      accountId: "default",
      cfg: { channels: { line: {} } } as OpenClawConfig,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
    expect(mocks.pushMessagesLine.mock.calls[0]?.[1]).toHaveLength(2);
    expect(result.messageId).toBe("m-batch");
  });

  it("batches a card, caption, and media into one provider request", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:batch",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/image.jpg",
        channelData: {
          line: {
            flexMessage: { altText: "Card", contents: { type: "bubble" } },
          },
        },
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:batch",
      [
        { type: "flex", altText: "Card", contents: { type: "bubble" } },
        { type: "text", text: "Caption" },
        {
          type: "image",
          originalContentUrl: "https://example.com/image.jpg",
          previewImageUrl: "https://example.com/image.jpg",
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });
});
