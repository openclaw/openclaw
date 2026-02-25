import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppAccount, resolveWhatsAppAuthDir } from "./accounts.js";

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

  it("sanitizes special characters in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "foo/bar\\baz",
    });
    // Sprawdzaj sanityzacje na segmencie accountId, nie na calej sciezce
    // (Windows uzywa backslash jako separator katalogow).
    const segment = path.basename(authDir);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
  });

  it("returns default directory for empty accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "",
    });
    expect(authDir).toMatch(/whatsapp[/\\]default$/);
  });

  it("preserves valid accountId unchanged", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "my-account-1",
    });
    expect(authDir).toMatch(/whatsapp[/\\]my-account-1$/);
  });

  it("merges top-level and account-specific config through shared helpers", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        messages: {
          messagePrefix: "[global]",
        },
        channels: {
          whatsapp: {
            sendReadReceipts: false,
            messagePrefix: "[root]",
            debounceMs: 100,
            accounts: {
              work: {
                debounceMs: 250,
              },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.sendReadReceipts).toBe(false);
    expect(resolved.messagePrefix).toBe("[root]");
    expect(resolved.debounceMs).toBe(250);
  });

  it("account groups override root groups (no deep merge)", () => {
    // An account setting groups: {} or a subset must fully override root.groups
    // so that routing/gating and prompt surfaces see a consistent picture.
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            groups: {
              "*": { systemPrompt: "Root wildcard prompt" },
              "120363406415684625@g.us": { requireMention: true },
            },
            accounts: {
              work: {
                groups: {
                  "120363406415684625@g.us": { requireMention: false },
                },
              },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    // Account groups replace root groups entirely — root "*" must not bleed in.
    expect(resolved.groups?.["*"]).toBeUndefined();
    expect(resolved.groups?.["120363406415684625@g.us"]).toEqual({ requireMention: false });
  });

  it("account direct config overrides root direct config (no deep merge)", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            direct: {
              "*": { systemPrompt: "Root direct wildcard" },
              "+15551234567": { systemPrompt: "Root direct prompt" },
            },
            accounts: {
              work: {
                direct: {
                  "+15551234567": { systemPrompt: "Account direct prompt" },
                },
              },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });

    expect(resolved.direct?.["*"]).toBeUndefined();
    expect(resolved.direct?.["+15551234567"]).toEqual({ systemPrompt: "Account direct prompt" });
  });
});
