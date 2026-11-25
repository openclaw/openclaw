import fs from "node:fs/promises";
import path from "node:path";
import { runWithSpawnBroker } from "../../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../../process/spawn-broker/host.js";
import { createReadTool } from "./read.js";

const [root, logPath] = process.argv.slice(2);
const results = [];
for (const mode of ["local", "standalone", "broker"]) {
  const filePath = path.join(root!, mode === "local" ? "local.txt" : `${mode}.sqlite`);
  const broker = mode === "broker" ? createSpawnBrokerHost() : undefined;
  try {
    await broker?.ready();
    const result = await runWithSpawnBroker(broker, () =>
      createReadTool(root!).execute("source-work", { path: filePath }),
    );
    const reads: { file: string; bytes: number }[] = (await fs.readFile(logPath!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bytesRead = reads
      .filter((read) => read.file === filePath)
      .reduce((sum, read) => sum + read.bytes, 0);
    results.push({ mode, details: result.details, bytesRead });
  } finally {
    await broker?.close();
  }
}
console.log(JSON.stringify(results));
