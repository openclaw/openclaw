import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCorePluginConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { runDreamingSweepPhases } from "../../extensions/memory-core/src/dreaming-phases.js";

const PROOF_DAY = "2026-07-08";
const PROOF_TS = `${PROOF_DAY}T10:00:00.000Z`;

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return [true, i];
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return [true, i];
    }
  }
  return [false, -1];
}

async function main() {
  const workspaceDir = path.join(os.tmpdir(), "openclaw-surrogate-proof-" + Date.now());
  const memoryDir = path.join(workspaceDir, "memory");
  const stateDir = path.join(workspaceDir, ".state");
  await fs.mkdir(memoryDir, { recursive: true });

  // normalizeDailySnippet strips "- " prefix then truncates to 280.
  // "- " (2) + 279 ASCII + 🌍 (2 utf16) = stripped text = 281 => truncation drops emoji
  const pad = "x".repeat(279);
  const emoji = "🌍";

  const dailyContent = [
    `# ${PROOF_DAY}`,
    "",
    `- ${pad}${emoji}`,
    `- Regular item: completed Q2 review`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(memoryDir, `${PROOF_DAY}.md`), dailyContent, "utf-8");

  // Session transcript
  Reflect.set(process.env, "OPENCLAW_TEST_FAST", "1");
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  await fs.mkdir(sessionsDir, { recursive: true });
  const transcriptPath = path.join(sessionsDir, "surrogate-proof.jsonl");
  const sessionPad = "y".repeat(279);
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "session", id: "surrogate-proof", timestamp: PROOF_TS }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          timestamp: PROOF_TS,
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
          timestamp: PROOF_TS,
          content: [{ type: "text", text: `Investigating the ${sessionPad}${emoji} issue now.` }],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const mtime = new Date(`${PROOF_DAY}T10:30:00.000Z`);
  await fs.utimes(transcriptPath, mtime, mtime);

  const testConfig = {
    plugins: {
      entries: {
        "memory-core": {
          config: {
            dreaming: {
              enabled: true,
              timezone: "UTC",
              storage: { mode: "inline", separateReports: false },
              phases: {
                light: { enabled: true, limit: 20, lookbackDays: 2 },
                rem: { enabled: true, limit: 20, lookbackDays: 2 },
              },
            },
          },
        },
      },
    },
    agents: {
      defaults: { workspace: workspaceDir, userTimezone: "UTC" },
    },
  };

  const subagent = {
    run: async () => ({ runId: "proof-run" }),
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({
      messages: [{ role: "assistant", content: "Dreaming narrative generated." }],
    }),
    deleteSession: async () => {},
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  await runDreamingSweepPhases({
    workspaceDir,
    cfg: testConfig,
    pluginConfig: resolveMemoryCorePluginConfig(testConfig),
    logger,
    subagent,
    detachNarratives: false,
    nowMs: Date.parse(`${PROOF_DAY}T11:00:00.000Z`),
  });

  // Read generated artifacts
  const dailyMd = await fs.readFile(path.join(memoryDir, `${PROOF_DAY}.md`), "utf-8");
  const corpusPath = path.join(memoryDir, ".dreams", "session-corpus", `${PROOF_DAY}.txt`);
  const corpus = await fs.readFile(corpusPath, "utf-8");

  const [dailyBad, dailyPos] = hasLoneSurrogate(dailyMd);
  const [corpusBad, corpusPos] = hasLoneSurrogate(corpus);

  // Extract dreaming sections from daily markdown
  const lightMatch = dailyMd.match(
    /<!-- openclaw:dreaming:light:start -->([\s\S]*?)<!-- openclaw:dreaming:light:end -->/,
  );
  const remMatch = dailyMd.match(
    /<!-- openclaw:dreaming:rem:start -->([\s\S]*?)<!-- openclaw:dreaming:rem:end -->/,
  );

  console.log("=== Real Behavior Proof: Dreaming Sweep with Emoji at 280-char Boundary ===");
  console.log("");
  console.log("Input construction:");
  console.log('  Daily line:   "- " + 279 x + 🌍 => stripped = 281 chars');
  console.log("  Session text: 279 y + 🌍 => 281 chars");
  console.log("  truncateUtf16Safe truncates at 280, dropping the emoji entirely");
  console.log("");
  console.log("=== Generated daily markdown (dreaming sections) ===");
  if (lightMatch) {
    console.log("--- Light Sleep ---");
    const lines = lightMatch[1].trim().split("\n");
    for (const line of lines.slice(0, 6)) console.log(line);
    console.log("...");
  }
  if (remMatch) {
    console.log("--- REM Sleep ---");
    const lines = remMatch[1].trim().split("\n");
    for (const line of lines.slice(0, 10)) console.log(line);
    console.log("...");
  }
  console.log("");
  console.log(
    "=== Generated session corpus (" + corpusPath.replace(workspaceDir, "<workspace>") + ") ===",
  );
  const corpusLines = corpus.trim().split("\n");
  for (const line of corpusLines.slice(0, 5)) {
    console.log(line.length > 120 ? line.slice(0, 120) + "..." : line);
  }
  console.log("");
  console.log("=== Lone surrogate check ===");
  console.log(
    "daily markdown:",
    dailyBad ? `FAIL at index ${dailyPos}` : "PASS (zero lone surrogates)",
  );
  console.log(
    "session corpus:",
    corpusBad ? `FAIL at index ${corpusPos}` : "PASS (zero lone surrogates)",
  );
  console.log("");
  console.log("daily markdown size:", dailyMd.length, "bytes");
  console.log("session corpus size:", corpus.length, "bytes");
  console.log("session corpus exists:", corpus.length > 0 ? "YES" : "NO");
}

main().catch((err) => {
  console.error("Proof failed:", err);
  process.exit(1);
});
