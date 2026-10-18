import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("matrix doctor streaming alias migration", () => {
  function normalizeMatrixEntry(entry: Record<string, unknown>) {
    return normalizeCompatibilityConfig({ cfg: { channels: { matrix: entry } } as never });
  }

  function matrixEntryOf(result: { config: unknown }): Record<string, unknown> {
    const channels = (result.config as { channels?: Record<string, unknown> }).channels;
    return channels?.matrix as Record<string, unknown>;
  }

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
});
