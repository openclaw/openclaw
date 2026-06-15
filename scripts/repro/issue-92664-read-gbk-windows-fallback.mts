/**
 * Reproduction and verification script for issue #92664 / PR #92680.
 *
 * Demonstrates that the read tool handles GBK-encoded text through the
 * shared decodeWindowsOutputBuffer fallback path without crashing, even
 * without an explicit encoding parameter.
 *
 * Uses a mock readFile that returns raw GBK bytes (as a Chinese Windows
 * system would produce).  On Windows with a matching codepage the decoded
 * text would be correct Chinese.  On non-Windows the fallback produces
 * replacement characters for the non-ASCII portion; ASCII content such as
 * "Hello world" always survives intact.
 *
 * Run: node --import tsx scripts/repro/issue-92664-read-gbk-windows-fallback.mts
 */
import { createReadToolDefinition } from "../../src/agents/sessions/tools/read.js";

async function main() {
  // GBK encoding of "你好，世界\r\nHello world"
  const gbkBytes = Buffer.from([
    0xc4, 0xe3, // 你
    0xba, 0xc3, // 好
    0xa3, 0xac, // ，
    0xca, 0xc0, // 世
    0xbd, 0xe7, // 界
    0x0d, 0x0a,
    0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, // Hello world
  ]);

  const tool = createReadToolDefinition("/workspace", {
    operations: {
      access: async () => {},
      detectImageMimeType: async () => null,
      readFile: async () => gbkBytes,
    },
  });

  // No explicit encoding — the read tool auto-detects non-UTF-8 content
  // through the decodeWindowsOutputBuffer fallback chain.
  const result = await tool.execute("repro-call", { path: "note.txt" });
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  if (!text || text.length === 0) {
    console.error("FAIL: read tool returned empty text for GBK bytes");
    process.exitCode = 1;
    return;
  }

  // ASCII portion ("Hello world") should always survive intact
  if (!text.includes("Hello world")) {
    console.error("FAIL: ASCII portion 'Hello world' was corrupted");
    console.error("Got:", text);
    process.exitCode = 1;
    return;
  }

  console.log("PASS: read tool handles GBK bytes without crashing.");
  console.log(`Decoded length: ${text.length}`);
  console.log(`ASCII content preserved: Hello world ✓`);
  console.log(`Full output: ${text}`);
}

main().catch((err: unknown) => {
  console.error("FAIL: read tool threw on GBK bytes:", err);
  process.exitCode = 1;
});
