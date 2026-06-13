import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadToolDefinition } from "../../src/agents/sessions/tools/read.js";

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92664-"));
  const fileName = "gbk-note.txt";
  const filePath = path.join(tmpDir, fileName);

  // GBK-encoded bytes that a Chinese Windows system would produce.
  // The read tool auto-detects non-UTF-8 content and decodes through the
  // Windows codepage fallback chain.  On a Chinese Windows host the decoded
  // text would be "你好，世界"; on non-Windows hosts the fallback produces
  // replacement characters, which is expected.
  const gbkBytes = Buffer.from([
    0xc4, 0xe3, // 你
    0xba, 0xc3, // 好
    0xa3, 0xac, // ，
    0xca, 0xc0, // 世
    0xbd, 0xe7, // 界
    0x0d, 0x0a,
    0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, // Hello world
  ]);

  await fs.writeFile(filePath, gbkBytes);

  const tool = createReadToolDefinition(tmpDir, { autoResizeImages: false });
  // No explicit encoding — the read tool auto-detects non-UTF-8 content.
  const result = await tool.execute("repro-call", { path: fileName });
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  await fs.rm(tmpDir, { recursive: true, force: true });

  if (!text.trim()) {
    console.error("FAIL: read tool returned empty text for a GBK-encoded file");
    process.exitCode = 1;
    return;
  }

  console.log("PASS: GBK-encoded file read without explicit encoding parameter.");
  console.log(`Decoded text length: ${text.length}`);
  console.log(`Decoded: ${text}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
