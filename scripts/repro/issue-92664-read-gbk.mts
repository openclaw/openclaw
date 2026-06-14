import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadToolDefinition } from "../../src/agents/sessions/tools/read.js";

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92664-"));
  const fileName = "gbk-note.txt";
  const filePath = path.join(tmpDir, fileName);
  const original = "你好，世界\r\nHello world";

  // GBK encoding of "你好，世界\r\nHello world"
  // These are the actual bytes that would be in a GBK-encoded file on Chinese Windows
  const gbkBytes = Buffer.from([
    // 你好，世界
    0xc4, 0xe3, // 你
    0xba, 0xc3, // 好
    0xa3, 0xac, // ，
    0xca, 0xc0, // 世
    0xbd, 0xe7, // 界
    // \r\n
    0x0d, 0x0a,
    // Hello world (ASCII is the same in GBK)
    0x48, 0x65, 0x6c, 0x6c, 0x6f, // Hello
    0x20, // space
    0x77, 0x6f, 0x72, 0x6c, 0x64, // world
  ]);

  await fs.writeFile(filePath, gbkBytes);

  const tool = createReadToolDefinition(tmpDir, { autoResizeImages: false });
  const result = await tool.execute("repro-call", {
    path: fileName,
    encoding: "gbk",
  });
  const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  await fs.rm(tmpDir, { recursive: true, force: true });

  if (text !== original) {
    console.error("FAIL: decoded text does not match");
    console.error("Expected:", original);
    console.error("Got:", text);
    process.exitCode = 1;
    return;
  }

  console.log("PASS: GBK-encoded file decoded correctly.");
  console.log(`Decoded: ${text}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
