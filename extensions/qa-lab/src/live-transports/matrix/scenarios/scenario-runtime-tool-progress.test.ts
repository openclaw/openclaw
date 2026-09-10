import { readFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";
import { runToolProgressMentionSafetyScenario } from "./scenario-runtime-tool-progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("skips the release-file-backed mention progress scenario on Windows", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await expect(
      runToolProgressMentionSafetyScenario({} as MatrixQaScenarioContext),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: "Matrix tool progress mention safety requires POSIX shell support.",
    });
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

describe.skipIf(process.platform === "win32")("Matrix mention progress gate", () => {
  it("releases an unreleased gate during failure cleanup", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    await gate.cleanup();

    await expect(readFile(gatePath, "utf8")).resolves.toBe("matrix-progress-cancelled\n");
  });

  it("writes the release marker idempotently", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    await Promise.all([gate.release(), gate.release()]);

    await expect(readFile(gatePath, "utf8")).resolves.toBe("matrix-progress-observed\n");
    await gate.cleanup();
    await expect(readFile(gatePath, "utf8")).resolves.toBe("matrix-progress-observed\n");
  });

  it("rejects release after cleanup", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    await gate.cleanup();

    await expect(gate.release()).rejects.toThrow("has already been cleaned up");
  });
});
