import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("resolveNextcloudTalkAccount", () => {
  it("matches normalized configured account ids", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: {
        channels: {
          "nextcloud-talk": {
            accounts: {
              "Ops Team": {
                baseUrl: "https://cloud.example.com",
                botSecret: "bot-secret",
              },
            },
          },
        },
      } as CoreConfig,
      accountId: "ops-team",
    });

    expect(account.accountId).toBe("ops-team");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("bot-secret");
    expect(account.secretSource).toBe("config");
  });

  it.runIf(process.platform !== "win32")("rejects symlinked botSecretFile paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-"));
    const secretFile = path.join(dir, "secret.txt");
    const secretLink = path.join(dir, "secret-link.txt");
    fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
    fs.symlinkSync(secretFile, secretLink);

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecretFile: secretLink,
        },
      },
    } as CoreConfig;

    const account = resolveNextcloudTalkAccount({ cfg });
    expect(account.secret).toBe("");
    expect(account.secretSource).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
