import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("matrix doctor", () => {
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
