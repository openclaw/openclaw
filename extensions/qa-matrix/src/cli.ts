import type { Command } from "commander";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "./shared/live-transport-cli.js";

type MatrixQaCliRuntime = typeof import("./cli.runtime.js");

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<MatrixQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function flushProcessStream(stream: NodeJS.WriteStream) {
  if (stream.destroyed || !stream.writable) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadMatrixQaCliRuntime();
  await runtime.runQaMatrixCommand(opts);
  if (process.env.OPENCLAW_QA_MATRIX_DISABLE_SUCCESS_EXIT !== "1") {
    // Matrix crypto native handles can outlive the QA run even after every
    // client/gateway/harness has been stopped. This command is single-shot, so
    // a successful artifact write should terminate deterministically instead of
    // waiting for external timeout cleanup.
    await Promise.all([flushProcessStream(process.stdout), flushProcessStream(process.stderr)]);
    process.exit(0);
  }
}

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });

export const qaRunnerCliRegistrations = [matrixQaCliRegistration] as const;

export function registerMatrixQaCli(qa: Command) {
  matrixQaCliRegistration.register(qa);
}
