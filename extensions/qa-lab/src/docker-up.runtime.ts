import { execFile } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeQaDockerHarnessFiles } from "./docker-harness.js";

type QaDockerUpResult = {
  outputDir: string;
  composeFile: string;
  qaLabUrl: string;
  gatewayUrl: string;
  stopCommand: string;
};

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

type FetchLike = (input: string) => Promise<{ ok: boolean }>;

const DEFAULT_QA_DOCKER_DIR = path.resolve(process.cwd(), ".artifacts/qa-docker");

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

async function isPortFree(port: number) {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to find free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function resolveHostPort(preferredPort: number, pinned: boolean) {
  if (pinned || (await isPortFree(preferredPort))) {
    return preferredPort;
  }
  return await findFreePort();
}

function trimCommandOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split("\n");
  return lines.length <= 120 ? trimmed : lines.slice(-120).join("\n");
}

async function execCommand(command: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const renderedStdout = trimCommandOutput(stdout);
          const renderedStderr = trimCommandOutput(stderr);
          reject(
            new Error(
              [
                `Command failed: ${[command, ...args].join(" ")}`,
                renderedStderr ? `stderr:\n${renderedStderr}` : "",
                renderedStdout ? `stdout:\n${renderedStdout}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function waitForHealth(
  url: string,
  deps: {
    label?: string;
    fetchImpl: FetchLike;
    sleepImpl: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const timeoutMs = deps.timeoutMs ?? 240_000;
  const pollMs = deps.pollMs ?? 1_000;
  const startMs = Date.now();
  const deadline = startMs + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await deps.fetchImpl(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned non-OK for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await deps.sleepImpl(pollMs);
  }

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  const service = deps.label ?? url;
  const lines = [
    `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
    lastError ? `Last error: ${describeError(lastError)}` : "",
    "Hint: check container logs with `docker compose -f <compose-file> logs` and verify the port is not already in use.",
  ];
  throw new Error(lines.filter(Boolean).join("\n"));
}

export async function runQaDockerUp(
  params: {
    repoRoot?: string;
    outputDir?: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    skipUiBuild?: boolean;
  },
  deps?: {
    runCommand?: RunCommand;
    fetchImpl?: FetchLike;
    sleepImpl?: (ms: number) => Promise<unknown>;
  },
): Promise<QaDockerUpResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir = path.resolve(params.outputDir ?? DEFAULT_QA_DOCKER_DIR);
  const gatewayPort = await resolveHostPort(
    params.gatewayPort ?? 18789,
    params.gatewayPort != null,
  );
  const qaLabPort = await resolveHostPort(params.qaLabPort ?? 43124, params.qaLabPort != null);
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl =
    deps?.fetchImpl ??
    (async (input: string) => {
      return await fetch(input);
    });
  const sleepImpl = deps?.sleepImpl ?? sleep;

  if (!params.skipUiBuild) {
    await runCommand("pnpm", ["qa:lab:build"], repoRoot);
  }

  await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort,
    qaLabPort,
    providerBaseUrl: params.providerBaseUrl,
    imageName: params.image,
    usePrebuiltImage: params.usePrebuiltImage,
    includeQaLabUi: true,
  });

  const composeFile = path.join(outputDir, "docker-compose.qa.yml");

  // Tear down any previous stack from this compose file so ports are freed
  // and we get a clean restart every time.
  try {
    await runCommand(
      "docker",
      ["compose", "-f", composeFile, "down", "--remove-orphans"],
      repoRoot,
    );
  } catch {
    // First run or already stopped — ignore.
  }

  const composeArgs = ["compose", "-f", composeFile, "up"];
  if (!params.usePrebuiltImage) {
    composeArgs.push("--build");
  }
  composeArgs.push("-d");

  await runCommand("docker", composeArgs, repoRoot);

  const qaLabUrl = `http://127.0.0.1:${qaLabPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/`;

  await waitForHealth(`${qaLabUrl}/healthz`, { label: "QA Lab", fetchImpl, sleepImpl });
  await waitForHealth(`${gatewayUrl}healthz`, { label: "Gateway", fetchImpl, sleepImpl });

  return {
    outputDir,
    composeFile,
    qaLabUrl,
    gatewayUrl,
    stopCommand: `docker compose -f ${composeFile} down`,
  };
}
