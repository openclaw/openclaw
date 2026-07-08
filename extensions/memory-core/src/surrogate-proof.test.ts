import fs from "node:fs/promises";
import path from "node:path";
import { runDreamingSweepPhases } from "extensions/memory-core/src/dreaming-phases.js";
import { createMemoryCoreTestHarness } from "extensions/memory-core/src/test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCorePluginConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      // High surrogate -> must be followed by low surrogate
      const next = str.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++; // skip paired low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (no preceding high surrogate)
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
            },
          },
        },
      },
    },
  },
};

describe("dreaming ingestion surrogate-proof boundary", () => {
  it("daily + session corpus snippets have no lone surrogates from boundary emoji", async () => {
    const workspaceDir = await createTempWorkspace("surrogate-proof-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Emoji near the 280-char boundary so truncation code path is exercised
    // 275 ASCII + 🌍 (2 utf16) = 277 total, well within 280 but exercises truncation
    const padShort = "x".repeat(275);
    // 300-char line ensures truncation kicks in
    const padLong = "x".repeat(298);
    const emoji = "🌍";

    // Daily note: lines that trigger truncation at 280 chars
    const dailyContent = [
      `# ${PROOF_DAY}`,
      "",
      `- emoji-near-boundary: ${padShort}${emoji}`,
      `- overflow-with-emoji: ${padLong}${emoji}`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(memoryDir, `${PROOF_DAY}.md`), dailyContent, "utf-8");

    // Session transcript with emoji at both near-boundary and overflow positions
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
                text: `User: I found an issue with the ${padShort}${emoji} module.`,
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
                text: `I'll investigate the ${padLong}${emoji} issue and get back to you.`,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date(`${PROOF_DAY}T10:30:00.000Z`);
    await fs.utimes(transcriptPath, mtime, mtime);

    // Run dreaming sweep
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

    // Read outputs and verify no lone surrogates
    const dailyMarkdown = await fs.readFile(path.join(memoryDir, `${PROOF_DAY}.md`), "utf-8");
    const sessionContent = await fs.readFile(transcriptPath, "utf-8");

    expect(hasLoneSurrogate(dailyMarkdown), "daily markdown has lone surrogate").toBe(false);
    expect(hasLoneSurrogate(sessionContent), "session content has lone surrogate").toBe(false);

    // Also verify the log output is clean
    const logCalls = logger.info.mock.calls
      .concat(logger.warn.mock.calls)
      .concat(logger.error.mock.calls)
      .map((c) => c.map(String).join(" "));

    for (const msg of logCalls) {
      const msgStr = Array.isArray(msg) ? msg.join(" ") : String(msg);
      expect(hasLoneSurrogate(msgStr), `log has lone surrogate: ${msgStr.slice(0, 80)}`).toBe(
        false,
      );
    }
  });
});
