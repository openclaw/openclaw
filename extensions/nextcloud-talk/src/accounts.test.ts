import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("resolveNextcloudTalkAccount", () => {
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
