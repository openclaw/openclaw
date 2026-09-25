import { fileURLToPath, pathToFileURL } from "node:url";
import type { VitestWorkerDescriptor } from "./vitest-worker-artifacts.mts";

const descriptorKey = Symbol.for("openclaw.vitest.compiled-subprocess-descriptor");
const bootstrapProcess = process as NodeJS.Process & {
  [descriptorKey]?: VitestWorkerDescriptor;
};

export function getVitestWorkerDescriptor(): VitestWorkerDescriptor | undefined {
  return bootstrapProcess[descriptorKey];
}

// Private argv keeps the generation out of config hashes and inherited Node
// preloads. The project runner or Vitest still parses its original CLI arguments.
if (import.meta.main) {
  // Configs import the descriptor getter; do not hold this module's evaluation
  // open while the CLI loads those configs.
  void (async () => {
    try {
      const [directory, cli, ...args] = process.argv.slice(2);
      if (!directory || !cli) {
        throw new Error("Compiled subprocess bootstrap requires a directory and test CLI");
      }
      bootstrapProcess[descriptorKey] = { directory };
      const cliUrl = pathToFileURL(cli);
      process.argv = [process.argv[0]!, fileURLToPath(cliUrl), ...args];
      await import(cliUrl.href);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  })();
}
