// Whatsapp tests cover doctor contract plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withStateDirEnv, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function whatsappConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { whatsapp: entry } } as never;
}

async function writeLidMapping(dir: string, lid: string, phone: string | number): Promise<void> {
  await fs.writeFile(path.join(dir, `lid-mapping-${lid}_reverse.json`), JSON.stringify(phone));
}

describe("whatsapp streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.whatsapp");

  it("matches flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: true } } }, {})).toBe(false);
  });
});

it("removes retired exposeErrorText at root and account level", () => {
  const result = normalizeCompatibilityConfig({
    cfg: whatsappConfig({ exposeErrorText: true, accounts: { work: { exposeErrorText: false } } }),
  });
  expect(result.config.channels?.whatsapp).toEqual({ accounts: { work: {} } });
  expect(result.changes).toContain("Removed retired channels.whatsapp.exposeErrorText.");
  expect(result.changes).toContain(
    "Removed retired channels.whatsapp.accounts.work.exposeErrorText.",
  );
});

describe("whatsapp normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "newline",
        blockStreaming: false,
        accounts: {
          personal: { blockStreamingCoalesce: { minChars: 20 } },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "newline", block: { enabled: false } });
    expect(whatsapp.chunkMode).toBeUndefined();
    expect(whatsapp.blockStreaming).toBeUndefined();
    const personal = (whatsapp.accounts as Record<string, Record<string, unknown>>).personal;
    // WhatsApp's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root delivery settings.
    expect(personal?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: false, coalesce: { minChars: 20 } },
    });
    expect(personal?.blockStreamingCoalesce).toBeUndefined();
  });

  it("seeds named accounts from accounts.default over root (layered inheritance)", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "length",
        accounts: {
          default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "length" });
    expect(accounts.default?.streaming).toEqual({
      chunkMode: "length",
      block: { enabled: true },
    });
    // The old flat keys resolved per key across named > accounts.default >
    // root, so the materialized work object must inherit the default
    // account's block setting, not just the root chunk mode.
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
  });

  it("resolves the default account case-insensitively when seeding named accounts", () => {
    // resolveAccountEntry matches account keys case-insensitively, so
    // `accounts.Default` is the runtime default account too.
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        accounts: {
          Default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });
  });

  it("keeps the legacy ackReaction migration and stays idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: {
        messages: { ackReaction: "👀" },
        channels: { whatsapp: { blockStreaming: true } },
      } as never,
    });
    const whatsapp = first.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.ackReaction).toEqual({ emoji: "👀", direct: false, group: "mentions" });
    expect(whatsapp.streaming).toEqual({ block: { enabled: true } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});

describe("whatsapp allowlist LID upgrade", () => {
  it("reports LID entries at channel and account scope", () => {
    const rootRule = legacyConfigRules.find((rule) =>
      rule.message.startsWith("WhatsApp allowFrom or groupAllowFrom contains LID JIDs"),
    );
    const accountsRule = legacyConfigRules.find((rule) =>
      rule.message.startsWith("A WhatsApp account allowFrom or groupAllowFrom contains LID JIDs"),
    );

    expect(rootRule?.match?.({ allowFrom: ["whatsapp:777:2@hosted.lid"] }, {})).toBe(true);
    expect(rootRule?.match?.({ groupAllowFrom: ["whatsapp:777:2@hosted.lid"] }, {})).toBe(true);
    expect(rootRule?.match?.({ allowFrom: ["+15551230000"] }, {})).toBe(false);
    expect(accountsRule?.match?.({ work: { allowFrom: ["888@lid"] } }, {})).toBe(true);
    expect(accountsRule?.match?.({ work: { groupAllowFrom: ["888@lid"] } }, {})).toBe(true);
  });

  it("migrates only entries backed by a stored reverse mapping", async () => {
    await withTempDir("openclaw-whatsapp-doctor-", async (authDir) => {
      await writeLidMapping(authDir, "777", "15551230001");
      await writeLidMapping(authDir, "888", 15551230002);
      const result = normalizeCompatibilityConfig({
        cfg: whatsappConfig({
          authDir,
          allowFrom: ["777:4@lid", "whatsapp:888@hosted.lid", "15551239999@lid", "+15551230003"],
        }),
      });

      expect(result.config.channels?.whatsapp?.allowFrom).toEqual([
        "15551230001",
        "15551230002",
        "15551239999@lid",
        "+15551230003",
      ]);
      expect(result.changes).toHaveLength(2);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          'channels.whatsapp.allowFrom entry "15551239999@lid" was not migrated because no verified LID→PN mapping was found',
        ),
      ]);
    });
  });

  it("uses the owning account auth directory", async () => {
    await withTempDir("openclaw-whatsapp-doctor-account-", async (authDir) => {
      await writeLidMapping(authDir, "999", "447700900123");
      const result = normalizeCompatibilityConfig({
        cfg: whatsappConfig({
          accounts: {
            work: {
              authDir,
              allowFrom: ["999:2@hosted.lid"],
              groupAllowFrom: ["999:3@lid"],
            },
          },
        }),
      });

      const accounts = result.config.channels?.whatsapp?.accounts as Record<
        string,
        { allowFrom?: string[]; groupAllowFrom?: string[] }
      >;
      expect(accounts.work?.allowFrom).toEqual(["447700900123"]);
      expect(accounts.work?.groupAllowFrom).toEqual(["447700900123"]);
      expect(result.warnings).toEqual([]);
    });
  });

  it.each(["allowFrom", "groupAllowFrom"] as const)(
    "requires every account inheriting accounts.default %s to verify the mapping",
    async (key) => {
      await withTempDir("openclaw-whatsapp-doctor-default-scope-", async (rootDir) => {
        const defaultAuthDir = path.join(rootDir, "default");
        const workAuthDir = path.join(rootDir, "work");
        await fs.mkdir(defaultAuthDir);
        await fs.mkdir(workAuthDir);
        await writeLidMapping(defaultAuthDir, "456", "15550000456");
        const cfg = whatsappConfig({
          accounts: {
            default: { authDir: defaultAuthDir, [key]: ["456@lid"] },
            work: { authDir: workAuthDir },
          },
        });

        const unresolved = normalizeCompatibilityConfig({ cfg });
        const unresolvedAccounts = unresolved.config.channels?.whatsapp?.accounts as Record<
          string,
          Record<string, unknown>
        >;
        expect(unresolvedAccounts.default?.[key]).toEqual(["456@lid"]);
        expect(unresolved.warnings).toEqual([
          expect.stringContaining("no verified LID→PN mapping was found"),
        ]);

        await writeLidMapping(workAuthDir, "456", "15550000456");
        const migrated = normalizeCompatibilityConfig({ cfg });
        const migratedAccounts = migrated.config.channels?.whatsapp?.accounts as Record<
          string,
          Record<string, unknown>
        >;
        expect(migratedAccounts.default?.[key]).toEqual(["15550000456"]);
        expect(migrated.warnings).toEqual([]);
      });
    },
  );

  it("excludes a named account's own allowlist from default-account mapping scopes", async () => {
    await withTempDir("openclaw-whatsapp-doctor-default-override-", async (rootDir) => {
      const defaultAuthDir = path.join(rootDir, "default");
      const workAuthDir = path.join(rootDir, "work");
      await fs.mkdir(defaultAuthDir);
      await fs.mkdir(workAuthDir);
      await writeLidMapping(defaultAuthDir, "654", "15550000654");
      const result = normalizeCompatibilityConfig({
        cfg: whatsappConfig({
          accounts: {
            default: { authDir: defaultAuthDir, allowFrom: ["654@lid"] },
            work: { authDir: workAuthDir, allowFrom: ["+15550000999"] },
          },
        }),
      });

      const accounts = result.config.channels?.whatsapp?.accounts as Record<
        string,
        { allowFrom?: string[] }
      >;
      expect(accounts.default?.allowFrom).toEqual(["15550000654"]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("does not migrate a named account from the legacy shared mapping directory", async () => {
    await withStateDirEnv("openclaw-whatsapp-doctor-shared-", async ({ stateDir }) => {
      const credentialsDir = path.join(stateDir, "credentials");
      const accountAuthDir = path.join(stateDir, "work-auth");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.mkdir(accountAuthDir);
      await writeLidMapping(credentialsDir, "321", "15550000321");
      vi.resetModules();
      try {
        const { normalizeCompatibilityConfig: normalizeFreshConfig } =
          await import("./doctor-contract.js");
        const result = normalizeFreshConfig({
          cfg: whatsappConfig({
            accounts: {
              work: {
                authDir: accountAuthDir,
                allowFrom: ["321@lid"],
              },
            },
          }),
        });

        const accounts = result.config.channels?.whatsapp?.accounts as Record<
          string,
          { allowFrom?: string[] }
        >;
        expect(accounts.work?.allowFrom).toEqual(["321@lid"]);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining("no verified LID→PN mapping was found"),
        ]);
      } finally {
        vi.resetModules();
      }
    });
  });

  it.each(["allowFrom", "groupAllowFrom"] as const)(
    "requires a root mapping in every account that inherits root %s",
    async (key) => {
      await withTempDir("openclaw-whatsapp-doctor-root-scope-", async (rootDir) => {
        const otherKey = key === "allowFrom" ? "groupAllowFrom" : "allowFrom";
        const firstAuthDir = path.join(rootDir, "first");
        const secondAuthDir = path.join(rootDir, "second");
        await fs.mkdir(firstAuthDir);
        await fs.mkdir(secondAuthDir);
        await writeLidMapping(firstAuthDir, "456", "15550000456");
        const result = normalizeCompatibilityConfig({
          cfg: whatsappConfig({
            [key]: ["456@lid"],
            accounts: {
              first: { authDir: firstAuthDir },
              second: { authDir: secondAuthDir, [otherKey]: ["+15550000999"] },
            },
          }),
        });

        const whatsapp = result.config.channels?.whatsapp as Record<string, unknown> | undefined;
        expect(whatsapp?.[key]).toEqual(["456@lid"]);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining(
            `channels.whatsapp.${key} entry "456@lid" was not migrated because no verified LID→PN mapping was found`,
          ),
        ]);
      });
    },
  );

  it.each(["allowFrom", "groupAllowFrom"] as const)(
    "does not require root %s mappings from accounts with their own override",
    async (key) => {
      await withTempDir("openclaw-whatsapp-doctor-root-override-", async (rootDir) => {
        const inheritedAuthDir = path.join(rootDir, "inherited");
        const overridingAuthDir = path.join(rootDir, "overriding");
        await fs.mkdir(inheritedAuthDir);
        await fs.mkdir(overridingAuthDir);
        await writeLidMapping(inheritedAuthDir, "654", "15550000654");
        const result = normalizeCompatibilityConfig({
          cfg: whatsappConfig({
            [key]: ["654@lid"],
            accounts: {
              inherited: { authDir: inheritedAuthDir },
              overriding: {
                authDir: overridingAuthDir,
                [key]: ["+15550000999"],
              },
            },
          }),
        });

        const whatsapp = result.config.channels?.whatsapp as Record<string, unknown> | undefined;
        expect(whatsapp?.[key]).toEqual(["15550000654"]);
        expect(result.warnings).toEqual([]);
      });
    },
  );

  it("leaves an entry unchanged when stored mappings conflict", async () => {
    await withTempDir("openclaw-whatsapp-doctor-conflict-", async (rootDir) => {
      const firstAuthDir = path.join(rootDir, "first");
      const secondAuthDir = path.join(rootDir, "second");
      await fs.mkdir(firstAuthDir);
      await fs.mkdir(secondAuthDir);
      await writeLidMapping(firstAuthDir, "123", "15550000001");
      await writeLidMapping(secondAuthDir, "123", "15550000002");
      const result = normalizeCompatibilityConfig({
        cfg: whatsappConfig({
          allowFrom: ["123@lid"],
          accounts: {
            first: { authDir: firstAuthDir },
            second: { authDir: secondAuthDir },
          },
        }),
      });

      expect(result.config.channels?.whatsapp?.allowFrom).toEqual(["123@lid"]);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("conflicting LID→PN mappings were found"),
      ]);
    });
  });
});
