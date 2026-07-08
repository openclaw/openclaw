import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCorePluginConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const PROOF_DAY = "2026-07-08";

function setTestEnv(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_TEST_FAST", "1");
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreTestEnv(): void {
  Reflect.deleteProperty(process.env, "OPENCLAW_TEST_FAST");
  Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
}

afterEach(() => {
  restoreTestEnv();
});

function createMockSubagent(response = "Processed.") {
  const run = vi.fn(async () => ({ runId: "proof-run-1" }));
  const waitForRun = vi.fn(async () => ({ status: "ok" }));
  const getSessionMessages = vi.fn(async () => ({
    messages: [{ role: "assistant", content: response }],
  }));
  const deleteSession = vi.fn(async () => {});
  return { run, waitForRun, getSessionMessages, deleteSession };
}

function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const PROOF_CONFIG: OpenClawConfig = {
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            storage: { mode: "inline", separateReports: false },
            phases: {
              light: {
                enabled: true,
                limit: 20,
                lookbackDays: 2,
              },
              rem: {
                enabled: true,
                limit: 20,
                lookbackDays: 2,
              },
            },
          },
        },
      },
    },
  },
};

describe("dreaming ingestion surrogate-proof boundary", () => {
  it("generated daily markdown and session corpus have no lone surrogates", async () => {
    const workspaceDir = await createTempWorkspace("surrogate-proof-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // normalizeDailySnippet strips "- " prefix, then truncates to 280.
    // We need the stripped text to be 281 chars so truncation at 280 drops the emoji.
    // "- " (2) + 279 ASCII + 🌍 (2 utf16) = 283 total, stripped = 281
    const pad = "x".repeat(279);
    const emoji = "🌍";

    // normalizeSessionCorpusSnippet collapses whitespace then truncates.
    // Session message text with emoji at boundary.
    const sessionPad = "y".repeat(279);

    // Daily note: line where normalized text hits the 280-char emoji boundary
    const dailyContent = [
      `# ${PROOF_DAY}`,
      "",
      `- ${pad}${emoji}`,
      `- Regular short item`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(memoryDir, `${PROOF_DAY}.md`), dailyContent, "utf-8");

    // Session transcript with emoji at boundary in message text
    setTestEnv(path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "surrogate-proof.jsonl");
    const ts = `${PROOF_DAY}T10:00:00.000Z`;
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", id: "surrogate-proof", timestamp: ts }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: ts,
            content: [
              {
                type: "text",
                text: `I found a bug in the ${sessionPad}${emoji} module. Please investigate.`,
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: ts,
            content: [
              {
                type: "text",
                text: `Investigating the ${sessionPad}${emoji} issue now. Will report back shortly.`,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date(`${PROOF_DAY}T10:30:00.000Z`);
    await fs.utimes(transcriptPath, mtime, mtime);

    // Run full dreaming sweep (light + rem)
    const subagent = createMockSubagent("Dreaming narrative generated.");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const testConfig: OpenClawConfig = {
      ...PROOF_CONFIG,
      agents: {
        defaults: {
          workspace: workspaceDir,
          userTimezone: "UTC",
        },
      },
    };

    await runDreamingSweepPhases({
      workspaceDir,
      cfg: testConfig,
      pluginConfig: resolveMemoryCorePluginConfig(testConfig),
      logger,
      subagent,
      detachNarratives: false,
      nowMs: Date.parse(`${PROOF_DAY}T11:00:00.000Z`),
    });

    // Assert: generated daily markdown has no lone surrogates
    const dailyMarkdown = await fs.readFile(path.join(memoryDir, `${PROOF_DAY}.md`), "utf-8");
    expect(hasLoneSurrogate(dailyMarkdown), "daily markdown has lone surrogate").toBe(false);

    // Assert: generated session corpus file has no lone surrogates
    const sessionCorpusPath = path.join(memoryDir, ".dreams", "session-corpus", `${PROOF_DAY}.txt`);
    const sessionCorpus = await fs.readFile(sessionCorpusPath, "utf-8");
    expect(hasLoneSurrogate(sessionCorpus), "session corpus has lone surrogate").toBe(false);

    // Assert: all log output clean
    const logCalls = logger.info.mock.calls
      .concat(logger.warn.mock.calls)
      .concat(logger.error.mock.calls)
      .map((c) => c.map((item) => `${item}`).join(" "));
    for (const msg of logCalls) {
      expect(hasLoneSurrogate(msg), `log has lone surrogate: ${msg.slice(0, 80)}`).toBe(false);
    }
  });
});
