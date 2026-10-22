import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveMemoryDreamingPluginConfig,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { applyShortTermPromotions, type PromotionCandidate } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, createPromotionCandidateForTest } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const RAW_DREAMING_SECRET = "OPENAI_API_KEY=sk-1234567890abcdef"; // pragma: allowlist secret
const RAW_PROMOTION_SECRET = "OPENAI_API_KEY=sk-fedcba0987654321"; // pragma: allowlist secret

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await createTempWorkspace(prefix);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  clearRuntimeConfigSnapshot();
  return workspaceDir;
}

function promotionCandidate(
  key: string,
  line: number,
  originClass: "agent" | "owner" | "untrusted",
  sourcePath: string,
  snippet: string,
): PromotionCandidate {
  return createPromotionCandidateForTest({
    key,
    path: sourcePath,
    startLine: line,
    endLine: line,
    snippet,
    provenance: {
      originClass,
      sessionKind: "interactive",
      observedAt: Date.parse("2026-08-02T18:00:00.000Z"),
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

describe("memory-core transcript and promotion boundaries", () => {
  it("preserves sensitive interactive transcript content during dreaming ingestion", async () => {
    const workspaceDir = await createWorkspace("redaction-dreaming-");
    const safeControlText = "Safe control text survives transcript ingestion.";
    const dreaming = {
      enabled: true,
      timezone: "UTC",
      phases: {
        light: { enabled: true, limit: 20, lookbackDays: 7 },
        rem: { enabled: false, limit: 0, lookbackDays: 7 },
      },
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspaceDir, userTimezone: "UTC" },
        entries: { main: { workspace: workspaceDir } },
      },
      plugins: { entries: { "memory-core": { config: { dreaming } } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const identity = {
      agentId: "main",
      sessionId: "redaction-dreaming",
      sessionKey: "agent:main:chat:redaction-dreaming",
      storePath: path.join(sessionsDir, "sessions.json"),
    };
    const timestamp = "2026-08-03T18:00:00.000Z";
    const entry = { sessionId: identity.sessionId, updatedAt: Date.parse(timestamp) };
    await fs.mkdir(sessionsDir, { recursive: true });
    await upsertSessionEntry({ ...identity, entry });
    await appendSessionTranscriptMessageByIdentity({
      ...identity,
      message: {
        role: "user",
        content: [{ type: "text", text: `${safeControlText} ${RAW_DREAMING_SECRET}` }],
        timestamp,
        __openclaw: { senderIsOwner: true },
      },
    });
    await upsertSessionEntry({ ...identity, entry });

    await expect(
      runDreamingSweepPhases({
        agentId: "main",
        workspaceDir,
        cfg,
        pluginConfig: resolveMemoryDreamingPluginConfig(cfg) ?? {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: Date.parse("2026-08-03T19:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ failed: false });

    const corpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-08-03.txt"),
      "utf-8",
    );
    expect(corpus).toContain(safeControlText);
    expect(corpus).toContain(RAW_DREAMING_SECRET);
  });

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
      candidates: [
        promotionCandidate(cleanKey, 1, "owner", sourcePath, cleanText),
        promotionCandidate(contaminatedKey, 2, "agent", sourcePath, contaminatedText),
        promotionCandidate(untrustedKey, 3, "untrusted", sourcePath, untrustedText),
      ],
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
