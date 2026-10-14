import { fileURLToPath } from "node:url";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";

export async function measureBase64Memory(kind: "canonical" | "shredded", signal?: AbortSignal) {
  const result = await runNodeScript(
    [fileURLToPath(new URL("./base64.memory-probe.test-support.mjs", import.meta.url)), kind],
    process.env,
    15_000,
    { signal, maxBuffer: 4096, executable: process.execPath },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Base64 memory child failed: ${result.stderr}`, { cause: result.error });
  }
  return JSON.parse(result.stdout) as { vmDelta: number };
}
