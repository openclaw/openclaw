import { describe, expect, it, vi, beforeEach } from "vitest";
import { nostrPlugin } from "./channel.js";

// Mock the runtime module so tests do not need a live gateway.
vi.mock("./runtime.js", () => ({
  getNostrRuntime: vi.fn().mockReturnValue({
    config: {
      loadConfig: vi.fn().mockReturnValue({}),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn().mockReturnValue("preserve"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
    },
  }),
  setNostrRuntime: vi.fn(),
}));

const VALID_PUBKEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE_CTX = {
  cfg: {} as never,
  to: VALID_PUBKEY,
  text: "",
};

describe("nostrPlugin.outbound.sendMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is defined on the outbound adapter", () => {
    expect(nostrPlugin.outbound?.sendMedia).toBeTypeOf("function");
  });

  it("throws when no bus is running for the account", async () => {
    // No bus registered → guard must surface a clear error rather than silently
    // swallowing the delivery (the original bug: missing sendMedia caused the
    // delivery framework to skip delivery entirely before even reaching this point).
    await expect(
      nostrPlugin.outbound!.sendMedia!({
        ...BASE_CTX,
        text: "caption",
        mediaUrl: "https://example.com/photo.jpg",
      }),
    ).rejects.toThrow("Nostr bus not running");
  });

  it("throws when no bus is running with no text, url only", async () => {
    await expect(
      nostrPlugin.outbound!.sendMedia!({
        ...BASE_CTX,
        text: "",
        mediaUrl: "https://example.com/photo.jpg",
      }),
    ).rejects.toThrow("Nostr bus not running");
  });

  it("throws when no bus is running with text only, no url", async () => {
    await expect(
      nostrPlugin.outbound!.sendMedia!({
        ...BASE_CTX,
        text: "caption only",
        mediaUrl: undefined,
      }),
    ).rejects.toThrow("Nostr bus not running");
  });
});
