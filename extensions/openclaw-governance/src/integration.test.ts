// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AibomRecorder } from "./aibom/recorder.js";
import { AibomSigner } from "./aibom/signer.js";
import { verifyStoredEntry } from "./aibom/verifier.js";
import { CostLedger } from "./cost/ledger.js";
import { DlpScanner } from "./dlp/scanner.js";
import type { AibomRow, CostEntryRow, DlpFindingRow, GovernanceStore } from "./store/sqlite.js";

class InMemoryGovernanceStore {
  readonly aibom: AibomRow[] = [];
  readonly dlp: DlpFindingRow[] = [];
  readonly cost: CostEntryRow[] = [];

  insertAibom(row: AibomRow): void {
    this.aibom.push(row);
  }
  listAibomByRun(runId: string): AibomRow[] {
    return this.aibom.filter((r) => r.runId === runId);
  }
  insertDlpFinding(row: DlpFindingRow): void {
    this.dlp.push(row);
  }
  listDlpFindingsByRun(runId: string): DlpFindingRow[] {
    return this.dlp.filter((r) => r.runId === runId);
  }
  insertCostEntry(row: CostEntryRow): void {
    this.cost.push(row);
  }
  listCostEntries(): CostEntryRow[] {
    return [...this.cost];
  }
  close(): void {
    /* no-op */
  }
}

function makeSigner(): { signer: AibomSigner; cleanup: () => void } {
  const keyDir = mkdtempSync(join(tmpdir(), "openclaw-governance-test-"));
  const signer = AibomSigner.fromKeyDir({ keyDir });
  return {
    signer,
    cleanup: () => {
      rmSync(keyDir, { recursive: true, force: true });
    },
  };
}

describe("governance integration — INFERENCE_END round-trip", () => {
  it("records a signed AIBOM row that can be verified", () => {
    const { signer, cleanup } = makeSigner();
    try {
      const store = new InMemoryGovernanceStore() as unknown as GovernanceStore & {
        aibom: AibomRow[];
      };
      const recorder = new AibomRecorder(signer, store);

      const inferenceEnd = {
        modelId: "claude-opus-4-7",
        provider: "anthropic",
        sessionKey: "agent:main:test:abc",
        runId: "run-12345",
        channelId: "webchat",
        skillId: "verify",
        prompt: "What is the capital of France?",
        completion: "The capital of France is Paris.",
        toolsUsed: ["web_search"],
        trainingDataTags: [],
      };

      const recorded = recorder.record(inferenceEnd);

      expect(recorded.id).toBeTruthy();
      expect(recorded.signature).toMatch(/\./);
      expect(recorded.record.modelId).toBe("claude-opus-4-7");
      expect(recorded.record.provider).toBe("anthropic");
      expect(recorded.record.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded.record.completionHash).toMatch(/^[0-9a-f]{64}$/);

      const rows = (store as unknown as InMemoryGovernanceStore).listAibomByRun("run-12345");
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.runId).toBe("run-12345");
      expect(row.sessionKey).toBe("agent:main:test:abc");
      expect(row.modelId).toBe("claude-opus-4-7");
      expect(row.channelId).toBe("webchat");
      expect(row.skillId).toBe("verify");

      const stored = JSON.parse(row.recordJson) as Record<string, unknown>;
      const verifyResult = verifyStoredEntry(signer, {
        record: stored,
        signature: row.signature,
      });
      expect(verifyResult.status).toBe("verified");
    } finally {
      cleanup();
    }
  });

  it("DlpScanner finds SSN + credit card + email in an outbound payload", () => {
    const scanner = new DlpScanner({ defaultAction: "log" });
    const payload =
      "Please charge card 4111 1111 1111 1111 for user with SSN 123-45-6789, email test@example.com.";
    const result = scanner.scan(payload);
    const kinds = new Set(result.findings.map((f) => f.entityType));
    expect(kinds.has("CREDIT_CARD")).toBe(true);
    expect(kinds.has("US_SSN")).toBe(true);
    expect(kinds.has("EMAIL_ADDRESS")).toBe(true);
  });

  it("CostLedger records an entry with provider usage and totals it", () => {
    const store = new InMemoryGovernanceStore() as unknown as GovernanceStore;
    const ledger = new CostLedger(store, {
      pricesPerMillion: {
        "anthropic/claude-opus-4-7": { inputUsd: 15, outputUsd: 75 },
      },
    });
    const now = 1_700_000_000_000;
    const entry = ledger.record({
      runId: "run-12345",
      sessionKey: "agent:main:test:abc",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      channelId: "webchat",
      skillId: "verify",
      startedAtMs: now - 5_000,
      endedAtMs: now,
      usage: { inputTokens: 1_000, outputTokens: 500 },
    });
    expect(entry.inputTokens).toBe(1_000);
    expect(entry.outputTokens).toBe(500);
    expect(entry.source).toBe("provider");
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(entry.costUsd).toBeCloseTo(15 * 0.001 + 75 * 0.0005, 6);

    const rows = (store as unknown as InMemoryGovernanceStore).listCostEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("run-12345");
  });

  it("CostLedger prices cache-read and cache-write tokens", () => {
    const store = new InMemoryGovernanceStore() as unknown as GovernanceStore;
    const ledger = new CostLedger(store);
    const now = 1_700_000_000_000;
    const entry = ledger.record({
      runId: "run-cache-1",
      sessionKey: "agent:main:test:cache",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      startedAtMs: now - 5_000,
      endedAtMs: now,
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 1_000,
      },
    });
    expect(entry.cacheReadTokens).toBe(2_000);
    expect(entry.cacheWriteTokens).toBe(1_000);
    const expected = 15 * 0.001 + 75 * 0.0005 + 1.5 * 0.002 + 18.75 * 0.001;
    expect(entry.costUsd).toBeCloseTo(expected, 6);
  });
});
