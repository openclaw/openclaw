import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

const MATRIX_QA_GATE_CONSUME_TIMEOUT_MS = 5_000;
const MATRIX_QA_GATE_POLL_INTERVAL_MS = 50;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function waitForMatrixMentionProgressGateConsumption(gatePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await stat(gatePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return true;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(MATRIX_QA_GATE_POLL_INTERVAL_MS);
  }
}

export async function prepareMatrixMentionProgressGate(
  context: Pick<MatrixQaScenarioContext, "gatewayWorkspaceDir">,
  opts: { consumeTimeoutMs?: number } = {},
) {
  if (!context.gatewayWorkspaceDir) {
    throw new Error("Matrix mention-safety progress requires a Gateway workspace directory.");
  }
  const gatePath = path.join(
    context.gatewayWorkspaceDir,
    MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY,
  );
  // Directory existence is the complete handshake. No migration is required:
  // existing state remains compatible, and the payload-free lifecycle test
  // verifies upgrade compatibility inside this disposable QA workspace.
  await rm(gatePath, { force: true, recursive: true });
  let closed = false;
  let gatePromise: Promise<void> | undefined;
  let consumptionPromise: Promise<boolean> | undefined;
  const waitForConsumption = () => {
    if (!gatePromise) {
      gatePromise = mkdir(gatePath);
    }
    if (!consumptionPromise) {
      consumptionPromise = gatePromise.then(() =>
        waitForMatrixMentionProgressGateConsumption(
          gatePath,
          opts.consumeTimeoutMs ?? MATRIX_QA_GATE_CONSUME_TIMEOUT_MS,
        ),
      );
    }
    return consumptionPromise;
  };
  const release = async () => {
    if (closed) {
      throw new Error("Matrix mention progress gate has already been cleaned up.");
    }
    if (!(await waitForConsumption())) {
      await rm(gatePath, { force: true, recursive: true });
      throw new Error("Matrix mention progress command did not consume its release gate.");
    }
  };
  const cleanup = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await waitForConsumption();
    } finally {
      await rm(gatePath, { force: true, recursive: true });
    }
  };
  return {
    release,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}
