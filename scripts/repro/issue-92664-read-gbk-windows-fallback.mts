/**
 * Reproduction and verification script for issue #92664 / PR #92680.
 *
 * Two-phase proof:
 *  1. Old decoder (plain UTF-8) → GBK text is garbled (proves fix is needed)
 *  2. Fixed read tool (platform: "win32" + windowsEncoding: "gbk") → 你好，世界
 *
 * Run: node --import tsx scripts/repro/issue-92664-read-gbk-windows-fallback.mts
 */
import { createReadToolDefinition } from "../../src/agents/sessions/tools/read.js";

const GBK_BYTES = Buffer.from([
  0xc4, 0xe3, // 你
  0xba, 0xc3, // 好
  0xa3, 0xac, // ，
  0xca, 0xc0, // 世
  0xbd, 0xe7, // 界
  0x0d, 0x0a,
  0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, // Hello world
]);

function textContent(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

async function main() {
  // ── Phase 1: Prove the old decoder is broken ──────────────────────────
  // Without the read-tool fix, current main decodes text via
  // buffer.toString("utf-8").  GBK bytes produce garbled mojibake.
  const utf8Decoded = GBK_BYTES.toString("utf-8");
  if (utf8Decoded.includes("你好，世界")) {
    console.error("FAIL (phase 1): plain UTF-8 unexpectedly decoded GBK — old decoder is not broken?");
    process.exitCode = 1;
    return;
  }

  console.log("Phase 1 PASS — old decoder produces garbled text:");
  console.log(`  UTF-8 decoded: ${utf8Decoded.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}`);
  console.log("  '你好，世界' NOT found (expected — fix is needed)");
  console.log();

  // ── Phase 2: Prove the fix decodes correct Chinese ────────────────────
  // The read tool now routes through decodeReadBuffer → decodeWindowsOutputBuffer.
  // Pass the test-only platform/windowsEncoding seam to simulate Chinese Windows.
  const tool = createReadToolDefinition("/workspace", {
    platform: "win32",
    windowsEncoding: "gbk",
    operations: {
      access: async () => {},
      detectImageMimeType: async () => null,
      readFile: async () => GBK_BYTES,
    },
  });

  const result = await tool.execute("repro-call", { path: "note.txt" });
  const text = textContent(result);

  if (!text.includes("你好，世界")) {
    console.error("FAIL (phase 2): fixed read tool did not return '你好，世界'");
    console.error("Got:", text);
    process.exitCode = 1;
    return;
  }

  if (!text.includes("Hello world")) {
    console.error("FAIL (phase 2): ASCII portion 'Hello world' was corrupted");
    console.error("Got:", text);
    process.exitCode = 1;
    return;
  }

  console.log("Phase 2 PASS — fixed read tool returns correct Chinese:");
  console.log(`  Output: ${text}`);
  console.log("  '你好，世界' found ✓");
  console.log("  'Hello world' found ✓");
}

main().catch((err: unknown) => {
  console.error("FAIL: repro script threw:", err);
  process.exitCode = 1;
});
