import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { telegramDoctor } from "./doctor.js";

const host = vi.hoisted(() => ({ gatewayOwnsListeners: false }));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    get getWebhookLegacyListener() {
      return host.gatewayOwnsListeners ? actual.getWebhookLegacyListener : undefined;
    },
  };
});

it.each([false, true])(
  "preserves visible listener guidance when Gateway owns listeners=%s",
  async (capable) => {
    host.gatewayOwnsListeners = capable;
    const run = telegramDoctor.runConfigSequence;
    if (!run) {
      throw new Error("Telegram Doctor sequence missing");
    }
    for (const legacyWebhook of [{ port: 9000 }, false] as const) {
      const cfg: OpenClawConfig = {
        channels: { telegram: { webhookUrl: "https://example.test/hook", legacyWebhook } },
      };
      const notes = await run({ cfg, env: {}, shouldRepair: false });
      expect(notes.changeNotes).toEqual([]);
      if (capable) {
        expect(notes.warningNotes).toEqual([]);
        expect(notes.infoNotes).toEqual([expect.stringContaining("Gateway port 18789")]);
      } else {
        expect(notes.infoNotes ?? []).toEqual([]);
        expect(notes.warningNotes).toEqual([
          expect.stringContaining("2026.9.6 compatibility listener"),
        ]);
        expect(notes.warningNotes[0]).toContain("Gateway port 18789");
        expect(notes.warningNotes[0]).toContain(
          legacyWebhook === false ? "disables" : "cannot share a legacy port across accounts",
        );
      }
      expect(cfg.channels?.telegram?.legacyWebhook).toEqual(legacyWebhook);
    }
  },
);
