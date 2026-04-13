import { spawnSync as runChildProcessSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runNodeScript(scriptPath: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = runChildProcessSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeRawArtifact(rawDir: string, callId: string, timestamp: number, transcript: unknown[]): string {
  const filePath = path.join(rawDir, `${callId}-${timestamp}.json`);
  const payload = {
    schema: "voice.postsync.raw.v1",
    createdAt: new Date(timestamp).toISOString(),
    call: {
      callId,
      transcript,
    },
  };
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

describe("replay-regression script", () => {
  it("fails with violations and writes latest pointer under voice-quality-harness root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-regression-test-"));
    const rawDir = path.join(tmpDir, "raw");

    writeRawArtifact(rawDir, "call-bad", 1_777_000_001_000, [
      { speaker: "bot", text: "That sounded nowwwww strange." },
      { speaker: "bot", text: "Sure thing." },
      { speaker: "bot", text: "sure thing!" },
    ]);

    const outPath = path.join(
      tmpDir,
      "projects/tess-phone-voice-v2/03_logs/voice-quality-harness/replay-regression/runs/run-1.json",
    );

    const script = path.resolve(process.cwd(), "scripts/replay-regression.ts");
    const result = runNodeScript(script, [
      "--call-id",
      "call-bad",
      "--raw-dir",
      rawDir,
      "--calls-file",
      path.join(tmpDir, "missing.jsonl"),
      "--out",
      outPath,
      "--json",
    ]);

    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.summary.totalViolations).toBe(2);
    expect(json.summary.violationsByRule.NO_ELONGATED_TOKEN).toBe(1);
    expect(json.summary.violationsByRule.NO_CONSECUTIVE_DUPLICATE_BOT_LINE).toBe(1);

    expect(fs.existsSync(outPath)).toBe(true);
    const latestPath = path.join(
      tmpDir,
      "projects/tess-phone-voice-v2/03_logs/voice-quality-harness/replay-regression/latest.json",
    );
    expect(fs.existsSync(latestPath)).toBe(true);
  });

  it("passes clean transcripts and exits 0", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-regression-clean-test-"));
    const rawDir = path.join(tmpDir, "raw");

    writeRawArtifact(rawDir, "call-good", 1_777_000_002_000, [
      { speaker: "bot", text: "Hey there, how can I help?" },
      { speaker: "user", text: "need a summary" },
      { speaker: "bot", text: "Got it. I can do that after the call." },
    ]);

    const script = path.resolve(process.cwd(), "scripts/replay-regression.ts");
    const result = runNodeScript(script, [
      "--call-id",
      "call-good",
      "--raw-dir",
      rawDir,
      "--calls-file",
      path.join(tmpDir, "missing.jsonl"),
      "--json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.summary.totalViolations).toBe(0);
    expect(json.summary.failedCalls).toBe(0);
  });
});
