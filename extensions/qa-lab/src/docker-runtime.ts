import { execFile } from "node:child_process";
import { createServer } from "node:net";

export type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export type FetchLike = (input: string) => Promise<{ ok: boolean }>;

export function describeError(error: unknown) {
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

export async function resolveHostPort(preferredPort: number, pinned: boolean) {
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

export async function execCommand(command: string, args: string[], cwd: string) {
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

export async function waitForHealth(
  url: string,
  deps: {
    label?: string;
    composeFile?: string;
    fetchImpl: FetchLike;
    sleepImpl: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const timeoutMs = deps.timeoutMs ?? 360_000;
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
    `Hint: check container logs with \`docker compose -f ${deps.composeFile ?? "<compose-file>"} logs\` and verify the port is not already in use.`,
  ];
  throw new Error(lines.filter(Boolean).join("\n"));
}

async function isHealthy(url: string, fetchImpl: FetchLike) {
  try {
    const response = await fetchImpl(url);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForDockerServiceHealth(
  service: string,
  composeFile: string,
  repoRoot: string,
  runCommand: RunCommand,
  sleepImpl: (ms: number) => Promise<unknown>,
  timeoutMs = 360_000,
  pollMs = 1_000,
) {
  const startMs = Date.now();
  const deadline = startMs + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    try {
      const { stdout } = await runCommand(
        "docker",
        ["compose", "-f", composeFile, "ps", "--format", "json", service],
        repoRoot,
      );
      const rows = stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { Health?: string; State?: string });
      const row = rows[0];
      lastStatus = row?.Health ?? row?.State ?? "unknown";
      if (lastStatus === "healthy" || lastStatus === "running") {
        return;
      }
    } catch (error) {
      lastStatus = describeError(error);
    }
    await sleepImpl(pollMs);
  }

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  throw new Error(
    [
      `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
      `Last status: ${lastStatus}`,
      `Hint: check container logs with \`docker compose -f ${composeFile} logs ${service}\`.`,
    ].join("\n"),
  );
}

export async function resolveComposeServiceUrl(
  service: string,
  port: number,
  composeFile: string,
  repoRoot: string,
  runCommand: RunCommand,
  fetchImpl?: FetchLike,
) {
  const { stdout: containerStdout } = await runCommand(
    "docker",
    ["compose", "-f", composeFile, "ps", "-q", service],
    repoRoot,
  );
  const containerId = containerStdout.trim();
  if (!containerId) {
    return null;
  }
  const { stdout: ipStdout } = await runCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      containerId,
    ],
    repoRoot,
  );
  const ip = ipStdout.trim();
  if (!ip) {
    return null;
  }
  const baseUrl = `http://${ip}:${port}/`;
  if (!fetchImpl) {
    return baseUrl;
  }
  return (await isHealthy(`${baseUrl}healthz`, fetchImpl)) ? baseUrl : null;
}
