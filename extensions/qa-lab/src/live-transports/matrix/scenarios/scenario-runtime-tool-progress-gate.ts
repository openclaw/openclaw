import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

export async function prepareMatrixMentionProgressGate(
  context: Pick<MatrixQaScenarioContext, "gatewayWorkspaceDir">,
) {
  if (!context.gatewayWorkspaceDir) {
    throw new Error("Matrix mention-safety progress requires a Gateway workspace directory.");
  }
  const gatePath = path.join(context.gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
  await rm(gatePath, { force: true });
  let closed = false;
  let releasePromise: Promise<void> | undefined;
  const release = async () => {
    if (closed) {
      throw new Error("Matrix mention progress gate has already been cleaned up.");
    }
    if (!releasePromise) {
      releasePromise = writeFile(gatePath, "matrix-progress-observed\n", "utf8");
    }
    await releasePromise;
  };
  const cleanup = async () => {
    if (closed) {
      return;
    }
    closed = true;
    if (!releasePromise) {
      releasePromise = writeFile(gatePath, "matrix-progress-cancelled\n", "utf8");
    }
    await releasePromise;
  };
  return {
    release,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}
