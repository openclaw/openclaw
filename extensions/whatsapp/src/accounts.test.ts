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

describe("resolveWhatsAppAccount groups multi-account inheritance (#69874)", () => {
  const rootGroups = {
    "*": { systemPrompt: "Default prompt for all groups." },
  } as const;
  const workGroups = {
    "120363406415684625@g.us": { systemPrompt: "Work-only prompt." },
  } as const;

  function buildCfg(accounts: Record<string, Record<string, unknown>>) {
    return {
      channels: {
        whatsapp: {
          groups: rootGroups,
          accounts,
        },
      },
    } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];
  }

  it("single-account: inherits channel-level groups when account defines none", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: {} }),
      accountId: "default",
    });
    expect(resolved.groups).toEqual(rootGroups);
  });

  it("single-account: account-level groups fully replaces channel-level groups", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: { groups: workGroups } }),
      accountId: "default",
    });
    expect(resolved.groups).toEqual(workGroups);
  });

  it("multi-account: channel-level groups is NOT inherited by a secondary account with no own groups", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: {}, work: {} }),
      accountId: "work",
    });
    expect(resolved.groups).toBeUndefined();
  });

  it("multi-account: channel-level groups is NOT inherited by the default account with no own groups", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: {}, work: {} }),
      accountId: "default",
    });
    expect(resolved.groups).toBeUndefined();
  });

  it("multi-account: account-level groups still wins over channel-level", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: {}, work: { groups: workGroups } }),
      accountId: "work",
    });
    expect(resolved.groups).toEqual(workGroups);
  });

  it("multi-account: accounts.default.groups shared defaults still flow to named accounts", () => {
    const resolved = resolveWhatsAppAccount({
      cfg: buildCfg({ default: { groups: rootGroups }, work: {} }),
      accountId: "work",
    });
    expect(resolved.groups).toEqual(rootGroups);
  });

  it("multi-account: root `direct` is not guarded (matches Telegram scope)", () => {
    const rootDirect = { "*": { systemPrompt: "DM default." } } as const;
    const resolved = resolveWhatsAppAccount({
      cfg: {
        channels: {
          whatsapp: {
            direct: rootDirect,
            accounts: { default: {}, work: {} },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
      accountId: "work",
    });
    expect(resolved.direct).toEqual(rootDirect);
  });
});
