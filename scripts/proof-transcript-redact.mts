/**
 * Real-behavior proof for appendSessionTranscriptMessage redaction.
 *
 * Writes a message containing a fake API key ("sk-abc...") to a temp JSONL,
 * then reads the file back and confirms:
 *   1. The key is masked on disk
 *   2. Safe text is preserved
 *   3. With redactSensitive:"off" the key is written as-is
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSessionTranscriptMessage } from "../src/config/sessions/transcript-append.js";

const FAKE_KEY = "sk-abcdef1234567890xyz";
const SAFE_TEXT = "Hello, the weather is fine today.";

async function readLastMessage(file: string) {
  const lines = (await fs.readFile(file, "utf-8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return lines[lines.length - 1];
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proof-redact-"));

  // ── Case 1: redaction ON (default) ──────────────────────────────────────
  const fileOn = path.join(dir, "session-on.jsonl");
  await appendSessionTranscriptMessage({
    transcriptPath: fileOn,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `My key is ${FAKE_KEY} and ${SAFE_TEXT}` }],
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    config: { logging: { redactSensitive: "tools" } } as any,
  });
  const entryOn = await readLastMessage(fileOn);
  const writtenTextOn: string = entryOn.message.content[0].text;

  const keyMasked = !writtenTextOn.includes(FAKE_KEY);
  const safeKept  = writtenTextOn.includes(SAFE_TEXT);

  console.log("\n── Case 1: redactSensitive = \"tools\" ──────────────────");
  console.log("Written text :", writtenTextOn);
  console.log("Key masked?  :", keyMasked  ? "✅ YES" : "❌ NO  ← FAIL");
  console.log("Safe text OK?:", safeKept   ? "✅ YES" : "❌ NO  ← FAIL");

  // ── Case 2: redaction OFF ────────────────────────────────────────────────
  const fileOff = path.join(dir, "session-off.jsonl");
  await appendSessionTranscriptMessage({
    transcriptPath: fileOff,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `My key is ${FAKE_KEY}` }],
    } as any,
    config: { logging: { redactSensitive: "off" } } as any,
  });
  const entryOff = await readLastMessage(fileOff);
  const writtenTextOff: string = entryOff.message.content[0].text;

  const keyPresent = writtenTextOff.includes(FAKE_KEY);

  console.log("\n── Case 2: redactSensitive = \"off\" ─────────────────────");
  console.log("Written text :", writtenTextOff);
  console.log("Key present? :", keyPresent ? "✅ YES (expected)" : "❌ NO  ← FAIL");

  // ── Case 3: no config (undefined — uses default patterns) ───────────────
  const fileUndef = path.join(dir, "session-undef.jsonl");
  await appendSessionTranscriptMessage({
    transcriptPath: fileUndef,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `My key is ${FAKE_KEY}` }],
    } as any,
    // config intentionally omitted
  });
  const entryUndef = await readLastMessage(fileUndef);
  const writtenTextUndef: string = entryUndef.message.content[0].text;

  const keyMaskedUndef = !writtenTextUndef.includes(FAKE_KEY);

  console.log("\n── Case 3: config = undefined (default patterns) ────────");
  console.log("Written text :", writtenTextUndef);
  console.log("Key masked?  :", keyMaskedUndef ? "✅ YES" : "❌ NO  ← FAIL");

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n── Summary ──────────────────────────────────────────────");
  const allPass = keyMasked && safeKept && keyPresent && keyMaskedUndef;
  console.log(allPass ? "✅  ALL CASES PASS" : "❌  SOME CASES FAILED");
  console.log("Proof files:", dir);

  await fs.rm(dir, { recursive: true });
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
