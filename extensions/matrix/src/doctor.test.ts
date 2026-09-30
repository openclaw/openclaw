// Matrix tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../config-doctor-api.js";
import { MatrixConfigSchema } from "./config-schema.js";
import { cleanStaleMatrixPluginConfig, collectMatrixInstallPathWarnings } from "./doctor.js";

describe("matrix doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function normalizeMatrixDmConfig(dm: Record<string, unknown>) {
    return normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            dm,
          },
        },
      } as never,
    });
  }

  function expectChangeContaining(changes: readonly string[], fragment: string): void {
    expect(changes.join("\n")).toContain(fragment);
  }

  it("warns on stale custom Matrix plugin paths and cleans them", async () => {
    const missingPath = path.join(tmpdir(), `openclaw-matrix-missing-${Date.now()}`);
    await fs.rm(missingPath, { recursive: true, force: true });

    const warnings = await collectMatrixInstallPathWarnings({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
      },
    });
    expect(warnings[0]).toContain("custom path that no longer exists");

    const cleaned = await cleanStaleMatrixPluginConfig({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
        load: { paths: [missingPath, "/other/path"] },
        allow: ["matrix", "other-plugin"],
      },
    });
    expect(cleaned.changes[0]).toContain("Removed stale Matrix plugin references");
    expect(cleaned.config.plugins?.load?.paths).toEqual(["/other/path"]);
    expect(cleaned.config.plugins?.allow).toEqual(["other-plugin"]);
  });

  it("normalizes legacy Matrix room allow aliases to enabled", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            groups: {
              "!ops:example.org": {
                allow: true,
              },
            },
            accounts: {
              work: {
                rooms: {
                  "!legacy:example.org": {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.matrix).toHaveProperty(["groups", "!ops:example.org"], {
      enabled: true,
    });
    expect(result.config.channels?.matrix).toHaveProperty(
      ["accounts", "work", "rooms", "!legacy:example.org"],
      {
        enabled: false,
      },
    );
    expect(result.changes).toContain(
      "Moved channels.matrix.groups.!ops:example.org.allow → channels.matrix.groups.!ops:example.org.enabled (true).",
    );
    expect(result.changes).toContain(
      "Moved channels.matrix.accounts.work.rooms.!legacy:example.org.allow → channels.matrix.accounts.work.rooms.!legacy:example.org.enabled (false).",
    );
  });

  it("normalizes legacy Matrix private-network aliases", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            allowPrivateNetwork: true,
            accounts: {
              work: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.matrix).toHaveProperty("network", {
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(result.config.channels?.matrix).toHaveProperty(["accounts", "work", "network"], {
      dangerouslyAllowPrivateNetwork: false,
    });
    expect(result.changes).toContain(
      "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
    );
    expect(result.changes).toContain(
      "Moved channels.matrix.accounts.work.allowPrivateNetwork → channels.matrix.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' with allowFrom to 'allowlist'", () => {
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
      allowFrom: ["@alice:example.org", "@bob:example.org"],
    });

    const matrixDm = (
      result.config.channels?.matrix as { dm?: { policy?: string; allowFrom?: string[] } }
    )?.dm;

    expect(matrixDm?.policy).toBe("allowlist");
    expect(matrixDm?.allowFrom).toEqual(["@alice:example.org", "@bob:example.org"]);
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "allowlist"',
    );
    expectChangeContaining(result.changes, "preserved 2 channels.matrix.dm.allowFrom entries");
  });

  it("migrates legacy 'trusted' policy with whitespace-only allowFrom entries to 'pairing'", () => {
    // Whitespace-only entries are dropped by downstream allowlist normalization,
    // so they must not count toward the allowFrom population check — otherwise
    // the migration would emit policy="allowlist" with an effectively empty
    // allowlist, silently blocking all DMs.
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
      allowFrom: ["   ", "\t", ""],
    });

    const matrixDm = (result.config.channels?.matrix as { dm?: { policy?: string } })?.dm;
    expect(matrixDm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "pairing"',
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' without allowFrom to 'pairing'", () => {
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
    });

    const matrixDm = (result.config.channels?.matrix as { dm?: { policy?: string } })?.dm;
    expect(matrixDm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "pairing"',
    );
  });

  it("migrates legacy per-account channels.matrix.accounts.<id>.dm.policy 'trusted'", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              work: {
                dm: {
                  enabled: true,
                  policy: "trusted",
                  allowFrom: ["@boss:example.org"],
                },
              },
              personal: {
                dm: {
                  enabled: true,
                  policy: "trusted",
                },
              },
            },
          },
        },
      } as never,
    });

    const accounts = (
      result.config.channels?.matrix as {
        accounts?: Record<string, { dm?: { policy?: string; allowFrom?: string[] } }>;
      }
    )?.accounts;

    expect(accounts?.work?.dm?.policy).toBe("allowlist");
    expect(accounts?.work?.dm?.allowFrom).toEqual(["@boss:example.org"]);
    expect(accounts?.personal?.dm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.accounts.work.dm.policy "trusted" → "allowlist"',
    );
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.accounts.personal.dm.policy "trusted" → "pairing"',
    );
  });

  it("leaves modern dm.policy values untouched", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            dm: {
              enabled: true,
              policy: "allowlist",
              allowFrom: ["@alice:example.org"],
            },
            accounts: {
              work: {
                dm: { enabled: true, policy: "pairing" },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.config).toEqual({
      channels: {
        matrix: {
          dm: {
            enabled: true,
            policy: "allowlist",
            allowFrom: ["@alice:example.org"],
          },
          accounts: {
            work: {
              dm: { enabled: true, policy: "pairing" },
            },
          },
        },
      },
    });
  });
});

describe("matrix doctor streaming alias migration", () => {
  function normalizeMatrixEntry(entry: Record<string, unknown>) {
    return normalizeCompatibilityConfig({ cfg: { channels: { matrix: entry } } as never });
  }

  function matrixEntryOf(result: { config: unknown }): Record<string, unknown> {
    const channels = (result.config as { channels?: Record<string, unknown> }).channels;
    return channels?.matrix as Record<string, unknown>;
  }

  it("preserves the matrix-local quiet mode when migrating scalar streaming", () => {
    const result = normalizeMatrixEntry({ streaming: "quiet" });
    expect(matrixEntryOf(result).streaming).toEqual({ mode: "quiet" });
  });

  it("migrates boolean streaming plus flat delivery keys into the nested shape", () => {
    const result = normalizeMatrixEntry({
      streaming: true,
      blockStreaming: true,
      chunkMode: "newline",
    });
    expect(matrixEntryOf(result).streaming).toEqual({
      mode: "partial",
      chunkMode: "newline",
      block: { enabled: true },
    });
    const matrix = matrixEntryOf(result);
    expect(matrix.blockStreaming).toBeUndefined();
    expect(matrix.chunkMode).toBeUndefined();
  });

  it("leaves mode unset when only flat delivery keys migrate (matrix defaults to off)", () => {
    const result = normalizeMatrixEntry({ blockStreaming: true });
    // No mode source: streaming stays mode-less because runtime resolves both
    // "absent" and "object without mode" to "off".
    expect(matrixEntryOf(result).streaming).toEqual({ block: { enabled: true } });
  });

  it("seeds materialized account objects from root (account merge replaces wholesale)", () => {
    const result = normalizeMatrixEntry({
      streaming: { mode: "quiet", chunkMode: "newline" },
      accounts: {
        work: { blockStreaming: true },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    // Matrix's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root settings (copying
    // freezes inheritance at fix time by design; the change message says so).
    expect(accounts.work?.streaming).toEqual({
      mode: "quiet",
      chunkMode: "newline",
      block: { enabled: true },
    });
    expect(accounts.work?.blockStreaming).toBeUndefined();
  });

  it("seeds root FLAT delivery keys into accounts that already had a streaming value", () => {
    // Pre-migration, root flat keys resolved per-key for every account even
    // when the account's own streaming value replaced the root object
    // wholesale; migration must not silently drop that inherited behavior.
    const result = normalizeMatrixEntry({
      blockStreaming: true,
      accounts: {
        work: { streaming: { mode: "quiet" } },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streaming).toEqual({ mode: "quiet", block: { enabled: true } });
  });

  it("keeps canonical root nested values over conflicting account flat keys", () => {
    const result = normalizeMatrixEntry({
      streaming: { mode: "quiet", block: { enabled: false } },
      accounts: {
        work: { blockStreaming: true },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    // Pre-migration the resolvers read the merged nested object first, so the
    // account flat key was dead while root nested set block.enabled.
    expect(accounts.work?.streaming).toEqual({ mode: "quiet", block: { enabled: false } });
  });

  it("strips junk streamMode keys instead of treating them as mode intent", () => {
    // Matrix never had a streamMode key (no schema field, no runtime read), so
    // migrating it into streaming.mode would invent a mode the account never
    // ran with; the root scalar keeps flowing to the account at runtime.
    const result = normalizeMatrixEntry({
      streaming: "quiet",
      accounts: {
        work: { streamMode: "partial" },
      },
    });
    const matrix = matrixEntryOf(result);
    expect(matrix.streaming).toEqual({ mode: "quiet" });
    const accounts = matrix.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streamMode).toBeUndefined();
    expect(accounts.work?.streaming).toBeUndefined();
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeMatrixEntry({ streaming: "quiet", blockStreaming: true });
    expect(first.changes.length).toBeGreaterThan(0);
    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});

describe("matrix doctor account streaming upgrade", () => {
  it.each([
    { preview: { toolProgress: false } },
    { progress: { commentary: true } },
    { rooms: { "!kept:example.org": { mode: "off" } } },
    { rooms: { "!kept:example.org": { progress: { commentary: false } } } },
  ])("leaves valid mode-less account streaming unchanged: %j", (streaming) => {
    const cfg = {
      channels: {
        matrix: { streaming: { mode: "progress" }, accounts: { work: { streaming } } },
      },
    };
    expect(MatrixConfigSchema.safeParse(cfg.channels.matrix).success).toBe(true);
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it.each([
    { rooms: { "*": { mode: "off" } } },
    { unsupportedOption: true, rooms: { "!kept:example.org": { mode: "partial" } } },
  ])("preserves missing-mode off fallback while repairing account streaming: %j", (legacy) => {
    const cfg = {
      channels: {
        matrix: {
          streaming: { mode: "progress" },
          accounts: { work: { streaming: { preview: { toolProgress: false }, ...legacy } } },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    const streaming = result.config.channels?.matrix?.accounts?.work?.streaming;
    expect(streaming).toEqual({
      mode: "off",
      preview: { toolProgress: false },
      rooms: "unsupportedOption" in legacy ? { "!kept:example.org": { mode: "partial" } } : {},
    });
    expect(MatrixConfigSchema.safeParse(result.config.channels?.matrix).success).toBe(true);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("repairs formerly accepted account settings through the registered config contract", () => {
    const room = "!kept:example.org";
    const cfg = {
      channels: {
        matrix: {
          streaming: { mode: "progress", rooms: { [room]: { mode: "off" } } },
          accounts: {
            work: {
              accessToken: "test-token",
              unrelatedOption: true,
              groups: { "*": { tools: { deny: ["message"] } } },
              streaming: {
                mode: "quiet",
                unsupportedOption: true,
                preview: { toolProgress: false, ignoredOption: true },
                rooms: {
                  "*": { mode: "off" },
                  "#alias:example.org": { mode: "off" },
                  [room]: { mode: "partial", ignoredOption: true },
                },
              },
            },
          },
        },
      },
    };
    const before = structuredClone(cfg);
    expect(MatrixConfigSchema.safeParse(cfg.channels.matrix).success).toBe(false);
    expect(
      legacyConfigRules.some(
        (rule) =>
          rule.path.join(".") === "channels.matrix.accounts" &&
          rule.match?.(cfg.channels.matrix.accounts),
      ),
    ).toBe(true);
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    const matrix = result.config.channels?.matrix;
    expect(MatrixConfigSchema.safeParse(matrix).success).toBe(true);
    expect(matrix?.accounts?.work).toEqual({
      ...before.channels.matrix.accounts.work,
      streaming: {
        mode: "quiet",
        preview: { toolProgress: false },
        rooms: { [room]: { mode: "partial" } },
      },
    });
    expect(matrix?.streaming).toEqual(before.channels.matrix.streaming);
    expect(cfg).toEqual(before);
    expect(result.changes.join("\n")).toContain("accounts.work.streaming.unsupportedOption");
    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(result.config);
  });

  it("retains supported commentary while pruning invalid commentary leaves", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              work: {
                streaming: {
                  progress: { commentary: true },
                  rooms: {
                    "!kept:example.org": { mode: "progress", progress: { commentary: false } },
                    "!invalid:example.org": { mode: "off", progress: { commentary: "false" } },
                  },
                },
              },
            },
          },
        },
      } as never,
    });
    expect(result.config.channels?.matrix?.accounts?.work?.streaming).toEqual({
      mode: "off",
      progress: { commentary: true },
      rooms: {
        "!kept:example.org": { mode: "progress", progress: { commentary: false } },
        "!invalid:example.org": { mode: "off", progress: {} },
      },
    });
    expect(MatrixConfigSchema.safeParse(result.config.channels?.matrix).success).toBe(true);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("keeps valid nested leaves and the prior off fallback when account values are invalid", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          matrix: {
            streaming: { mode: "progress" },
            accounts: {
              work: {
                streaming: {
                  mode: "unsupported",
                  block: { enabled: true, coalesce: { minChars: -1, maxChars: 500 } },
                  progress: { maxLines: 0, labels: ["kept", 42], toolProgress: false },
                  preview: "invalid",
                  rooms: { "!invalid-mode:example.org": { mode: "unsupported" } },
                },
              },
            },
          },
        },
      } as never,
    });
    const matrix = result.config.channels?.matrix;
    expect(MatrixConfigSchema.safeParse(matrix).success).toBe(true);
    expect(matrix?.accounts?.work?.streaming).toEqual({
      mode: "off",
      block: { enabled: true, coalesce: { maxChars: 500 } },
      progress: { labels: ["kept"], toolProgress: false },
      rooms: {},
    });
  });
});
