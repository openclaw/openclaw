import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordMemoryUtilizationReceipt,
  validateMemoryUtilizationReceipt,
  type MemoryUtilizationReceipt,
} from "./receipts.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

function createValidReceipt(): MemoryUtilizationReceipt {
  return {
    run_id: "run.receipt.alpha",
    task: "Verify memory utilization receipt plumbing.",
    memory_preflight: {
      performed: true,
      wiki_injectable: true,
      reason_if_not: null,
      files_read: [".openclaw-wiki/cache/agent-digest.json"],
      claims_used: ["claim.alpha"],
    },
    decisions_influenced_by_memory: [
      "Used claim.alpha to keep the implementation scoped to memory-wiki.",
    ],
    writeback: {
      performed: true,
      paths: ["memory/2026-05-21.md"],
    },
  };
}

describe("memory utilization receipts", () => {
  it("accepts valid receipts", () => {
    const result = validateMemoryUtilizationReceipt(createValidReceipt());

    expect(result).toEqual({ ok: true, receipt: createValidReceipt() });
  });

  it("rejects invalid receipts", () => {
    const invalid = {
      ...createValidReceipt(),
      memory_preflight: {
        performed: true,
        wiki_injectable: "yes",
        reason_if_not: null,
        files_read: ["memory/MEMORY.md", "memory/MEMORY.md"],
      },
      extra: true,
    };

    const result = validateMemoryUtilizationReceipt(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          { path: "<root>.extra", message: "additional property is not allowed" },
          { path: "memory_preflight.claims_used", message: "is required" },
          { path: "memory_preflight.wiki_injectable", message: "must be a boolean" },
          { path: "memory_preflight.files_read.1", message: "must be unique" },
        ]),
      );
    }
  });

  it("appends validated receipts to durable NDJSON", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-receipts-" });
    const logPath = path.join(config.vault.path, ".openclaw-wiki/telemetry/memory-receipts.jsonl");
    const receipt = createValidReceipt();

    const result = await recordMemoryUtilizationReceipt({ config, receipt });

    expect(result).toEqual({
      recorded: true,
      runId: receipt.run_id,
      logPath,
    });
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(receipt);
  });
});
