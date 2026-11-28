import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { shellEscape as shellQuote } from "openclaw/plugin-sdk/string-normalization-runtime";
import { writeQaDockerHarnessFiles } from "./docker-harness.js";
import {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
} from "./docker-runtime.js";

const QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS = 2_000;

async function isQaLabDockerHealthReachable(url: string) {
  try {
    const response = await fetchHealthUrl(url, {
      signal: AbortSignal.timeout(QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isMissingCommandError(error: unknown, command: string): boolean {
  if (!error) {
    return false;
  }
  if (typeof error !== "object") {
    return formatErrorMessage(error).includes(`spawn ${command} ENOENT`);
  }
  const candidate = error as { cause?: unknown; code?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (
    candidate.code === "ENOENT" ||
    message.includes(`spawn ${command} ENOENT`) ||
    message.includes(`${command}: command not found`)
  ) {
    return true;
  }
  return isMissingCommandError(candidate.cause, command);
}

async function runQaLabBuild(repoRoot: string) {
  try {
    await execCommand("pnpm", ["qa:lab:build"], repoRoot);
  } catch (error) {
    if (!isMissingCommandError(error, "pnpm")) {
      throw error;
    }
    await execCommand("corepack", ["pnpm", "qa:lab:build"], repoRoot);
  }
}

export async function runQaDockerUp(params: {
  repoRoot?: string;
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
  skipUiBuild?: boolean;
}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir = path.resolve(params.outputDir ?? path.join(repoRoot, ".artifacts/qa-docker"));
  const gatewayPort = await resolveHostPort(
    params.gatewayPort ?? 18789,
    params.gatewayPort != null,
  );
  const qaLabPort = await resolveHostPort(params.qaLabPort ?? 43124, params.qaLabPort != null);
  if (gatewayPort === qaLabPort) {
    throw new Error(
      `QA Lab gateway and UI host ports must be different. Both resolved to ${gatewayPort}.`,
    );
  }
  if (!params.skipUiBuild) {
    await runQaLabBuild(repoRoot);
  }

  await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort,
    qaLabPort,
    providerBaseUrl: params.providerBaseUrl,
    imageName: params.image,
    usePrebuiltImage: params.usePrebuiltImage,
    bindUiDist: params.bindUiDist,
  });

  const composeFile = path.join(outputDir, "docker-compose.qa.yml");

  // Tear down any previous stack from this compose file so ports are freed
  // and we get a clean restart every time.
  try {
    await execCommand(
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

  await execCommand("docker", composeArgs, repoRoot);

  const qaLabUrl = `http://127.0.0.1:${qaLabPort}`;
  const hostGatewayUrl = `http://127.0.0.1:${gatewayPort}/`;

  await waitForHealth(`${qaLabUrl}/healthz`, {
    label: "QA Lab",
    fetchImpl: fetchHealthUrl,
    sleepImpl: sleep,
    composeFile,
  });
  await waitForDockerServiceHealth(
    "openclaw-qa-gateway",
    composeFile,
    repoRoot,
    execCommand,
    sleep,
  );
  let gatewayUrl = hostGatewayUrl;
  if (!(await isQaLabDockerHealthReachable(`${hostGatewayUrl}healthz`))) {
    const containerGatewayUrl = await resolveComposeServiceUrl(
      "openclaw-qa-gateway",
      18789,
      composeFile,
      repoRoot,
      execCommand,
      fetchHealthUrl,
    );
    if (containerGatewayUrl) {
      gatewayUrl = containerGatewayUrl;
    }
  }

  return {
    outputDir,
    composeFile,
    qaLabUrl,
    gatewayUrl,
    stopCommand: `docker compose -f ${shellQuote(composeFile)} down`,
  };
}
