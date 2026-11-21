// Whatsapp tests cover account-scoped LID authorization behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

async function writeLidMapping(authDir: string, lid: string, phone: string): Promise<void> {
  await fs.writeFile(path.join(authDir, `lid-mapping-${lid}_reverse.json`), JSON.stringify(phone));
}

function whatsappConfig(accounts: Record<string, { authDir: string }>): OpenClawConfig {
  return { channels: { whatsapp: { accounts } } };
}

describe("resolveWhatsAppOutboundTarget LID mappings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks a reassigned LID before sending a reaction", async () => {
    await withTempDir("openclaw-whatsapp-outbound-reassigned-", async (authDir) => {
      const send = vi.spyOn(whatsAppActionRuntime, "sendReactionWhatsApp").mockResolvedValue();
      const cfg: OpenClawConfig = {
        channels: { whatsapp: { allowFrom: ["15551230000"], accounts: { work: { authDir } } } },
      };
      await writeLidMapping(authDir, "777", "15551230000");
      await fs.writeFile(path.join(authDir, "lid-mapping-15551230000.json"), '"777"');
      const action = {
        action: "react",
        chatJid: "777@hosted.lid",
        messageId: "m1",
        emoji: "✅",
        accountId: "work",
      };

      await handleWhatsAppAction(action, cfg);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        "777@hosted.lid",
        "m1",
        "✅",
        expect.objectContaining({ accountId: "work" }),
      );

      // Baileys replaces the forward entry but leaves the old reverse entry.
      await writeLidMapping(authDir, "888", "15551230000");
      await fs.writeFile(path.join(authDir, "lid-mapping-15551230000.json"), '"888"');
      await expect(handleWhatsAppAction(action, cfg)).rejects.toThrow(
        "not in the configured allowFrom list",
      );
      expect(send).toHaveBeenCalledTimes(1);
      await handleWhatsAppAction({ ...action, chatJid: "888@hosted.lid" }, cfg);
      expect(send).toHaveBeenLastCalledWith(
        "888@hosted.lid",
        "m1",
        "✅",
        expect.objectContaining({ accountId: "work" }),
      );
    });
  });

  it("authorizes a LID target through the owning account's verified PN mapping", async () => {
    await withTempDir("openclaw-whatsapp-outbound-lid-", async (authDir) => {
      await writeLidMapping(authDir, "777", "15551230000");

      expect(
        resolveWhatsAppOutboundTarget({
          to: "777:2@hosted.lid",
          allowFrom: ["15551230000"],
          mode: "implicit",
          cfg: whatsappConfig({ work: { authDir } }),
          accountId: "work",
        }),
      ).toEqual({ ok: true, to: "777@hosted.lid" });
    });
  });

  it("does not authorize a LID target from another account's mapping", async () => {
    await withTempDir("openclaw-whatsapp-outbound-owner-", async (ownerAuthDir) => {
      await withTempDir("openclaw-whatsapp-outbound-other-", async (otherAuthDir) => {
        await writeLidMapping(ownerAuthDir, "777", "15551230000");

        const result = resolveWhatsAppOutboundTarget({
          to: "777@lid",
          allowFrom: ["15551230000"],
          mode: "implicit",
          cfg: whatsappConfig({
            owner: { authDir: ownerAuthDir },
            other: { authDir: otherAuthDir },
          }),
          accountId: "other",
        });

        expect(result.ok).toBe(false);
      });
    });
  });
});
