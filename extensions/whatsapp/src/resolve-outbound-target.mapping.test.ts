// Whatsapp tests cover account-scoped LID authorization behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

async function writeLidMapping(authDir: string, lid: string, phone: string): Promise<void> {
  await fs.writeFile(path.join(authDir, `lid-mapping-${lid}_reverse.json`), JSON.stringify(phone));
}

function whatsappConfig(accounts: Record<string, { authDir: string }>): OpenClawConfig {
  return { channels: { whatsapp: { accounts } } } as never;
}

describe("resolveWhatsAppOutboundTarget LID mappings", () => {
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
