// Whatsapp tests cover accounts plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
} from "./accounts.js";

describe("resolveWhatsAppAuthDir", () => {
  const stubCfg = { channels: { whatsapp: { accounts: {} } } } as Parameters<
    typeof resolveWhatsAppAuthDir
  >[0]["cfg"];

  it("sanitizes path traversal sequences in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "../../../etc/passwd",
    });
    // Sanitized accountId must not escape the whatsapp auth directory.
    expect(authDir).not.toContain("..");
    expect(path.basename(authDir)).not.toContain("/");
  });

  it("returns default directory for empty accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "",
    });
    expect(authDir).toMatch(/whatsapp[/\\]default$/);
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "~/.openclaw/whatsapp-default",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];

    expect(listWhatsAppAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultWhatsAppAccountId(cfg)).toBe("default");
    expect(resolveWhatsAppAccount({ cfg }).authDir).toMatch(/whatsapp-default$/);
  });

  it("does not inherit default-account authDir for named accounts", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                authDir: "/tmp/default-auth",
                name: "Personal",
              },
              work: {},
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.authDir).toMatch(/whatsapp[/\\]work$/);
    expect(resolved.name).toBeUndefined();
  });
});
