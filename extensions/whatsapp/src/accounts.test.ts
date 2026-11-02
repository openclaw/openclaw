import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
} from "./accounts.js";

function config(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp } };
}

describe("resolveWhatsAppAuthDir", () => {
  const base = config({ accounts: {} });

  it("sanitizes path traversal sequences in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({ cfg: base, accountId: "../../../etc/passwd" });
    expect(authDir).not.toContain("..");
    expect(path.basename(authDir)).not.toContain("/");
  });

  it("sanitizes special characters in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: base,
      accountId: "foo/bar\\baz",
    });
    // Sprawdzaj sanityzacje na segmencie accountId, nie na calej sciezce
    // (Windows uzywa backslash jako separator katalogow).
    const segment = path.basename(authDir);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
  });

  it("returns default directory for empty accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({ cfg: base, accountId: "" });
    expect(authDir).toMatch(/whatsapp[/\\]default$/);
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "~/.openclaw/whatsapp-default",
          accounts: { work: { enabled: false } },
        },
      },
    };

    expect(listWhatsAppAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultWhatsAppAccountId(cfg)).toBe("default");
    expect(resolveWhatsAppAccount({ cfg }).authDir).toMatch(/whatsapp-default$/);
  });

  it("preserves valid accountId unchanged", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: base,
      accountId: "my-account-1",
    });
    expect(authDir).toMatch(/whatsapp[/\\]my-account-1$/);
  });

  it("merges top-level and account-specific config through shared helpers", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            sendReadReceipts: false,
            responsePrefix: "[root]",
            accounts: {
              work: {},
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.sendReadReceipts).toBe(false);
    expect(resolved.messagePrefix).toBe("[root]");
  });

  it("inherits shared defaults from accounts.default for named accounts", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                dmPolicy: "allowlist",
                allowFrom: ["+15550001111"],
                groupPolicy: "open",
                groupAllowFrom: ["+15550002222"],
                defaultTo: "+15550003333",
                reactionLevel: "extensive",
                historyLimit: 42,
                mediaMaxMb: 12,
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.dmPolicy).toBe("allowlist");
    expect(resolved.allowFrom).toEqual(["+15550001111"]);
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.groupAllowFrom).toEqual(["+15550002222"]);
    expect(resolved.defaultTo).toBe("+15550003333");
    expect(resolved.reactionLevel).toBe("extensive");
    expect(resolved.historyLimit).toBe(42);
    expect(resolved.mediaMaxMb).toBe(12);
  });

  it("prefers account overrides and accounts.default over root defaults", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "disabled",
            accounts: {
              default: {
                dmPolicy: "allowlist",
                allowFrom: ["+15550001111"],
                groupPolicy: "open",
              },
              work: {
                authDir: "/tmp/work",
                dmPolicy: "pairing",
              },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.dmPolicy).toBe("pairing");
    expect(resolved.allowFrom).toEqual(["+15550001111"]);
    expect(resolved.groupPolicy).toBe("open");
  });

  it("does not inherit default-account authDir for named accounts", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: config({
        accounts: {
          default: { authDir: "/tmp/default-auth", name: "Personal" },
          work: {},
        },
      }),
      accountId: "work",
    });

    expect(resolved.authDir).toMatch(/whatsapp[/\\]work$/);
    expect(resolved.name).toBeUndefined();
  });

  it("does not inherit default-account selfChatMode for named accounts", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                selfChatMode: true,
              },
              work: {},
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.selfChatMode).toBeUndefined();
  });
});
