import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildCliSpeechProvider } from "./speech-provider.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspace = vi.hoisted(() => ({ root: "" }));

// Keep scratch allocation task-owned rather than touching the host's shared
// OpenClaw temp root. The real workspace permission and cleanup checks remain.
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => workspace.root,
}));

beforeEach(() => {
  workspace.root = tempDirs.make("openclaw-tts-command-workspace-");
});

function createCommandFixture() {
  const directory = tempDirs.make("openclaw-tts-command-args-");
  const script = path.join(directory, "capture-arguments.mjs");
  const receipt = path.join(directory, "arguments.json");
  const wav = Buffer.alloc(364);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  // Only the external speech executable is a fixture. The provider, command
  // parser, process runner, stdout capture, and temporary workspace are real.
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(Buffer.from(${JSON.stringify(wav.toString("base64"))}, "base64"));
`,
  );
  return { script, receipt, wav };
}

describe("local speech command argument preservation", () => {
  it.each([
    { name: "empty double-quoted value", command: '--voice ""', expected: ["--voice", ""] },
    { name: "empty single-quoted value", command: "--voice ''", expected: ["--voice", ""] },
    { name: "two empty arguments", command: "\"\" ''", expected: ["", ""] },
    { name: "quoted whitespace control", command: '--voice " "', expected: ["--voice", " "] },
    { name: "adjacent quote control", command: "--voice a''b", expected: ["--voice", "ab"] },
  ])("preserves $name through the real speech process", async ({ name, command, expected }) => {
    const fixture = createCommandFixture();
    const result = await buildCliSpeechProvider().synthesize({
      text: "spoken words",
      cfg: {},
      providerConfig: {
        command: `"${process.execPath}" "${fixture.script}" ${command}`,
        args: ["--tts-text", "{{Text}}"],
        outputFormat: "wav",
      },
      providerOverrides: {},
      target: "audio-file",
      timeoutMs: 10000,
    });
    const actual = z.array(z.string()).parse(JSON.parse(readFileSync(fixture.receipt, "utf8")));
    console.info("TTS_ARGUMENT_PROOF", JSON.stringify({ name, expected, actual }));
    expect(result.audioBuffer).toEqual(fixture.wav);
    expect(result.outputFormat).toBe("wav");
    expect(actual).toEqual([...expected, "--tts-text", "spoken words"]);
  });

  it("retains an empty argument supplied through the explicit args array", async () => {
    const fixture = createCommandFixture();
    const result = await buildCliSpeechProvider().synthesize({
      text: "spoken words",
      cfg: {},
      providerConfig: {
        command: process.execPath,
        args: [fixture.script, "--voice", "", "--tts-text", "{{Text}}"],
        outputFormat: "wav",
      },
      providerOverrides: {},
      target: "audio-file",
      timeoutMs: 10000,
    });
    expect(result.audioBuffer).toEqual(fixture.wav);
    expect(JSON.parse(readFileSync(fixture.receipt, "utf8"))).toEqual([
      "--voice",
      "",
      "--tts-text",
      "spoken words",
    ]);
  });
});
