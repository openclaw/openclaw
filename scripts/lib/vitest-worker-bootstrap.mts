import { fileURLToPath, pathToFileURL } from "node:url";
import { installVitestWorkerDescriptor } from "./vitest-worker-descriptor.mts";

// Private argv keeps the generation out of config hashes and inherited Node
// preloads. The project runner or Vitest still parses its original CLI arguments.
if (import.meta.main) {
  void (async () => {
    try {
      const [directory, ...args] = process.argv.slice(2);
      const preset = args[0] === "--worker-preset=runtime" ? "runtime" : "full";
      if (preset === "runtime") {
        args.shift();
      }
      const cli = args.shift();
      if (!directory || !cli) {
        throw new Error("Compiled subprocess bootstrap requires a directory and test CLI");
      }
      installVitestWorkerDescriptor({ directory, preset });
      const cliUrl = pathToFileURL(cli);
      process.argv = [process.argv[0]!, fileURLToPath(cliUrl), ...args];
      await import(cliUrl.href);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  })();
}
