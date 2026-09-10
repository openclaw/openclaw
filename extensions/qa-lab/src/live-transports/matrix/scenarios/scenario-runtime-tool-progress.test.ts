import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";
import { runToolProgressMentionSafetyScenario } from "./scenario-runtime-tool-progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("skips the release-directory-backed mention progress scenario on Windows", async () => {
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
  async function consumeGate(gatePath: string) {
    await expect
      .poll(async () => {
        try {
          return (await stat(gatePath)).isDirectory();
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(await readdir(gatePath)).toEqual([]);
    await rm(gatePath, { recursive: true });
  }

  it("verifies existing-state and upgrade compatibility without migration", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    const releasePromise = gate.release();
    await expect.poll(() => readdir(gatePath)).toEqual([]);
    await rm(gatePath, { recursive: true });
    await releasePromise;
    await gate.cleanup();

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for failure cleanup to release and consume the gate", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    const cleanupPromise = gate.cleanup();
    await consumeGate(gatePath);
    await cleanupPromise;

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the release directory idempotently and waits for consumption", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    const releases = Promise.all([gate.release(), gate.release()]);
    await consumeGate(gatePath);
    await releases;
    await gate.cleanup();

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an unconsumed gate after bounded cleanup", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const gate = await prepareMatrixMentionProgressGate(
      { gatewayWorkspaceDir },
      { consumeTimeoutMs: 10 },
    );

    await gate.cleanup();

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gate.release()).rejects.toThrow("has already been cleaned up");
  });

  it("does not mistake cleanup removal for command consumption", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_GATE_DIRECTORY);
    const gate = await prepareMatrixMentionProgressGate(
      { gatewayWorkspaceDir },
      { consumeTimeoutMs: 10 },
    );

    const releasePromise = gate.release();
    const cleanupPromise = gate.cleanup();

    await expect(releasePromise).rejects.toThrow("did not consume its release gate");
    await cleanupPromise;
    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
