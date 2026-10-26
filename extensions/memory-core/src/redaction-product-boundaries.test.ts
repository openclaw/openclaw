import fs from "node:fs/promises";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import { applyShortTermPromotions } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, createPromotionCandidateForTest } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const RAW_PROMOTION_SECRET = "OPENAI_API_KEY=sk-fedcba0987654321"; // pragma: allowlist secret

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await createTempWorkspace(prefix);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  clearRuntimeConfigSnapshot();
  return workspaceDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

describe("memory-core promotion boundaries", () => {
  it("promotes only clean trusted content across contamination and provenance gates", async () => {
    const workspaceDir = await createWorkspace("redaction-promotion-");
    const sourcePath = "memory/2026-08-03.md";
    const cleanKey = "clean-promotion-boundary";
    const contaminatedKey = "contaminated-promotion-boundary";
    const untrustedKey = "untrusted-promotion-boundary";
    const cleanText = "Keep the incident archive encrypted and access-controlled.";
    const contaminatedText = `Candidate: CONTAMINATED_DREAMING_BOUNDARY ${RAW_PROMOTION_SECRET} confidence: 0.99 evidence: memory/.dreams/session-corpus/2026-08-03.txt:1-1 recalls: 4 status: staged`;
    const untrustedText = "UNTRUSTED_PROMOTION_BOUNDARY must never enter durable memory.";
    await fs.writeFile(
      path.join(workspaceDir, sourcePath),
      `${[cleanText, contaminatedText, untrustedText].join("\n")}\n`,
      "utf-8",
    );

    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates: (
        [
          [cleanKey, "owner", cleanText],
          [contaminatedKey, "agent", contaminatedText],
          [untrustedKey, "untrusted", untrustedText],
        ] as const
      ).map(([key, originClass, snippet], index) =>
        createPromotionCandidateForTest({
          key,
          path: sourcePath,
          startLine: index + 1,
          endLine: index + 1,
          snippet,
          provenance: {
            originClass,
            sessionKind: "interactive",
            observedAt: Date.parse("2026-08-02T18:00:00.000Z"),
          },
        }),
      ),
      limit: 3,
      minScore: 0.9,
      minRecallCount: 3,
      minUniqueQueries: 2,
      maxAgeDays: 7,
      nowMs: Date.parse("2026-08-03T20:00:00.000Z"),
      timezone: "UTC",
    });

    expect(applied).toMatchObject({ applied: 1, appliedCandidates: [{ key: cleanKey }] });

    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain(cleanText);
    expect(memory).toContain(`<!-- openclaw-memory-promotion:${cleanKey} -->`);
    expect(memory).not.toContain(`openclaw-memory-promotion:${contaminatedKey}`);
    expect(memory).not.toContain("CONTAMINATED_DREAMING_BOUNDARY");
    expect(memory).not.toContain(`openclaw-memory-promotion:${untrustedKey}`);
    expect(memory).not.toContain(untrustedText);
    expect(memory).not.toContain(RAW_PROMOTION_SECRET);
    expect(memory).not.toContain("OPENAI_API_KEY=***");
  });
});
