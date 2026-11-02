import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { selectIOSReleaseGateway } from "./lib/ios-release-gateway.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "target-sha": { type: "string" },
      "selection-dir": { type: "string" },
    },
  });
  if (!values["target-sha"] || !values["selection-dir"]) {
    throw new Error("usage: --target-sha <full-sha> --selection-dir <directory>");
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const selection = await selectIOSReleaseGateway({
      targetSha: values["target-sha"],
      selectionDir: path.resolve(values["selection-dir"]),
      signal: abort.signal,
    });
    console.log(`Selected stable Gateway ${selection.version} (${selection.sourceSha}).`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Stable Gateway selection failed.");
    process.exitCode = 1;
  });
}
