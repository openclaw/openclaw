// Qa Matrix plugin module implements cli behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { loadQaRuntimeModule } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "./shared/live-transport-cli.js";

const DISABLE_MATRIX_QA_FORCE_EXIT_ENV = "OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT";

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

async function exitMatrixQaCommand(code: number): Promise<never> {
  // Matrix crypto native handles can outlive the QA run even after every
  // client/gateway/harness has been stopped. This command is single-shot, so
  // artifact completion should terminate deterministically on both pass and fail.
  await Promise.all([flushProcessStream(process.stdout), flushProcessStream(process.stderr)]);
  process.exit(code);
}

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const run = () => loadQaRuntimeModule().runQaMatrixCommand(opts);
  if (process.env[DISABLE_MATRIX_QA_FORCE_EXIT_ENV] === "1") {
    await run();
    return;
  }
  let exitCode: number;
  try {
    await run();
    exitCode = process.exitCode === undefined || process.exitCode === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    exitCode = 1;
  }
  await exitMatrixQaCommand(exitCode);
}

const matrixQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> = {
  id: "matrix",
  scenarioIds: [
    "channel-chat-baseline",
    "channel-canary",
    "channel-dm-group-routing",
    "channel-mention-gating",
    "channel-sender-allowlist",
    "channel-top-level-reply-shape",
    "channel-secondary-conversation-isolation",
    "channel-multi-actor-ordering",
    "thread-follow-up",
    "thread-isolation",
    "thread-reply-override",
    "dm-shared-session",
    "dm-per-room-session",
  ],
  matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
  async create(context) {
    return await loadQaRuntimeModule().createMatrixQaTransportAdapter(context);
  },
};

const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: matrixQaAdapterFactory,
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    profileHelp:
      "Matrix QA profile: all, fast, transport, media, e2ee-smoke, e2ee-deep, or e2ee-cli (default: all)",
    failFastHelp: "Stop after the first failed Matrix check or scenario",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });

export const qaRunnerCliRegistrations = [matrixQaCliRegistration] as const;
