import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { shouldDebounceWhatsAppInbound } from "./debounce-policy.js";

const image = { path: "/tmp/photo.jpg", type: "image/jpeg", kind: "image" as const };
const voiceNote = {
  path: "/tmp/voice.ogg",
  type: "audio/ogg; codecs=opus",
  kind: "audio" as const,
};

function config(whatsapp: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { whatsapp: { allowFrom: ["*"], ...whatsapp } } } as OpenClawConfig;
}

function decide(
  cfg: OpenClawConfig,
  overrides: Parameters<typeof createTestWebInboundMessage>[0],
  accountId = "default",
) {
  return shouldDebounceWhatsAppInbound({
    msg: createTestWebInboundMessage(overrides),
    cfg,
    accountId,
  });
}

describe("shouldDebounceWhatsAppInbound", () => {
  it("keeps media immediate unless debounceMedia is enabled", () => {
    const media = { payload: { body: "", media: image } };
    expect(decide(config(), media)).toBe(false);
    expect(decide(config({ debounceMedia: true }), media)).toBe(true);
    expect(
      decide(config({ debounceMedia: true }), { payload: { body: "", media: voiceNote } }),
    ).toBe(true);
  });

  it("holds direct-chat media but never group, quoted, or command media", () => {
    const cfg = config({ debounceMedia: true });
    expect(
      decide(cfg, {
        admission: { conversation: { kind: "group", id: "123@g.us" } },
        payload: { body: "", media: image },
      }),
    ).toBe(false);
    expect(decide(cfg, { payload: { body: "", media: image }, quote: { id: "earlier" } })).toBe(
      false,
    );
    expect(decide(cfg, { payload: { body: "/stop", media: image } })).toBe(false);
    expect(decide(cfg, { payload: { body: "look at this", media: image } })).toBe(true);
  });

  it("resolves the toggle per account", () => {
    const cfg = config({ accounts: { work: { debounceMedia: true } } });
    const media = { payload: { body: "", media: image } };
    expect(decide(cfg, media, "default")).toBe(false);
    expect(decide(cfg, media, "work")).toBe(true);
  });
});
