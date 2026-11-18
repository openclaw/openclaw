import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  execCommand,
  resolveComposeServiceUrl,
  waitForDockerServiceHealth,
} from "../../../docker-runtime.js";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_INTERNAL_PORT,
  MATRIX_QA_SERVICE,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  withMatrixQaHarnessTimeout,
  writeMatrixQaHarnessFiles,
} from "./harness.runtime-internals.js";
import { startMatrixQaRecordingProxy } from "./recording-proxy.js";

export async function startMatrixQaHarness(params: { outputDir: string; repoRoot?: string }) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const files = await writeMatrixQaHarnessFiles({
    outputDir: path.resolve(params.outputDir),
  });
  const compose = (...args: string[]) =>
    execCommand("docker", ["compose", "-f", files.composeFile, ...args], repoRoot);
  const resolvePublishedPort = async () =>
    parseMatrixQaPublishedPort(
      (await compose("port", MATRIX_QA_SERVICE, String(MATRIX_QA_INTERNAL_PORT))).stdout,
    );

  try {
    await compose("down", "--remove-orphans");
  } catch {
    // First run or already stopped.
  }

  try {
    await compose("up", "-d");
    const homeserverPort = await resolvePublishedPort();
    const resolveReadyUpstreamBaseUrl = async (publishedPort: number) => {
      await sleep(1_000);
      await waitForDockerServiceHealth(
        MATRIX_QA_SERVICE,
        files.composeFile,
        repoRoot,
        execCommand,
        sleep,
      );
      const hostBaseUrl = `http://127.0.0.1:${publishedPort}/`;
      let readyBaseUrl = hostBaseUrl;
      if (!(await isMatrixVersionsReachable(hostBaseUrl))) {
        const containerBaseUrl = await resolveComposeServiceUrl(
          MATRIX_QA_SERVICE,
          MATRIX_QA_INTERNAL_PORT,
          files.composeFile,
          repoRoot,
          execCommand,
        );
        readyBaseUrl = await waitForReachableMatrixBaseUrl({
          composeFile: files.composeFile,
          containerBaseUrl,
          hostBaseUrl,
        });
      }
      return readyBaseUrl;
    };
    let upstreamBaseUrl = await resolveReadyUpstreamBaseUrl(homeserverPort);
    const recording = await startMatrixQaRecordingProxy({ targetBaseUrl: upstreamBaseUrl });

    return {
      ...files,
      baseUrl: recording.baseUrl,
      recording,
      async restartService() {
        await withMatrixQaHarnessTimeout(
          "Matrix homeserver restart",
          MATRIX_QA_CLEANUP_TIMEOUT_MS,
          (async () => {
            await compose("restart", MATRIX_QA_SERVICE);
            const restartedPort = await resolvePublishedPort();
            upstreamBaseUrl = await resolveReadyUpstreamBaseUrl(restartedPort);
            recording.setTargetBaseUrl(upstreamBaseUrl);
          })(),
        );
      },
      stopCommand: `docker compose -f ${files.composeFile} down --remove-orphans`,
      async stop() {
        const results = await Promise.allSettled([
          recording.stop(),
          withMatrixQaHarnessTimeout(
            "Matrix homeserver cleanup",
            MATRIX_QA_CLEANUP_TIMEOUT_MS,
            compose("down", "--remove-orphans"),
          ),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Matrix QA harness cleanup failed");
        }
      },
      get upstreamBaseUrl() {
        return upstreamBaseUrl;
      },
    };
  } catch (error) {
    try {
      await withMatrixQaHarnessTimeout(
        "Matrix homeserver cleanup after startup failure",
        MATRIX_QA_CLEANUP_TIMEOUT_MS,
        compose("down", "--remove-orphans"),
      );
    } catch (cleanupError) {
      const combinedFailure = new AggregateError(
        [error, cleanupError],
        "Matrix QA harness startup and cleanup both failed",
        { cause: cleanupError },
      );
      throw combinedFailure;
    }
    throw error;
  }
}

function parseMatrixQaPublishedPort(output: string): number {
  const port = Number.parseInt(
    output
      .trim()
      .split(/\r?\n/, 1)[0]
      ?.match(/:(\d+)$/)?.[1] ?? "",
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Unable to resolve Matrix QA published port from Docker output: ${output.trim()}`,
    );
  }
  return port;
}
