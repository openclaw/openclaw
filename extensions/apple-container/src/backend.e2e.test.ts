import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectAppleContainer,
  runAppleContainerCli,
  type RunAppleContainerCliResult,
} from "./cli.js";
import { resolveAppleContainerPluginConfig } from "./config.js";

const OPENCLAW_APPLE_CONTAINER_E2E = process.env.OPENCLAW_E2E_APPLE_CONTAINER === "1";
const OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS = 2 * 60_000;

const DEFAULT_PLUGIN_CONFIG = resolveAppleContainerPluginConfig({});
const TEST_IMAGE = "alpine:latest";

async function appleContainerReady(): Promise<boolean> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return false;
  }
  try {
    const result = await runAppleContainerCli({
      config: DEFAULT_PLUGIN_CONFIG,
      args: ["system", "status", "--format", "json"],
    });
    const parsed = JSON.parse(result.stdout.toString("utf8")) as { status?: string };
    return parsed.status === "running";
  } catch {
    return false;
  }
}

async function removeContainer(name: string): Promise<void> {
  await runAppleContainerCli({
    config: DEFAULT_PLUGIN_CONFIG,
    args: ["delete", "--force", name],
    allowFailure: true,
  });
}

function containerName(suffix: string): string {
  return `openclaw-e2e-ac-${process.pid}-${suffix}`.slice(0, 63);
}

async function createAndStart(
  name: string,
  opts?: { network?: string; workspaceDir?: string },
): Promise<void> {
  const createArgs = [
    "create",
    "--name",
    name,
    "--label",
    "openclaw.sandbox=1",
    "--label",
    "openclaw.e2e=1",
  ];
  if (opts?.network) {
    createArgs.push("--network", opts.network);
  }
  if (opts?.workspaceDir) {
    createArgs.push("--volume", `${opts.workspaceDir}:/workspace`);
    createArgs.push("--workdir", "/workspace");
  }
  createArgs.push(TEST_IMAGE, "sleep", "infinity");
  await runAppleContainerCli({ config: DEFAULT_PLUGIN_CONFIG, args: createArgs });
  await runAppleContainerCli({ config: DEFAULT_PLUGIN_CONFIG, args: ["start", name] });
}

async function execInContainer(name: string, command: string): Promise<RunAppleContainerCliResult> {
  return await runAppleContainerCli({
    config: DEFAULT_PLUGIN_CONFIG,
    args: ["exec", "-i", name, "/bin/sh", "-c", command],
  });
}

describe("apple-container backend e2e", () => {
  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "creates a container, execs a command, and verifies output",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const name = containerName("exec");
      try {
        await createAndStart(name);

        const result = await execInContainer(name, "echo hello-from-apple-container");
        expect(result.stdout.toString("utf8").trim()).toBe("hello-from-apple-container");
        expect(result.code).toBe(0);
      } finally {
        await removeContainer(name);
      }
    },
  );

  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "writes a file through exec and reads it back on the host via bind mount",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ac-e2e-"));
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const name = containerName("fs");
      try {
        await createAndStart(name, { workspaceDir });

        await execInContainer(
          name,
          "mkdir -p /workspace/nested && echo from-apple > /workspace/nested/hello.txt",
        );

        const content = await fs.readFile(path.join(workspaceDir, "nested", "hello.txt"), "utf8");
        expect(content.trim()).toBe("from-apple");
      } finally {
        await removeContainer(name);
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "inspect returns container status and labels",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const name = containerName("inspect");
      try {
        await createAndStart(name);

        const info = await inspectAppleContainer({
          config: DEFAULT_PLUGIN_CONFIG,
          containerId: name,
        });
        expect(info).not.toBeNull();
        expect(info?.status).toBe("running");
        expect(info?.configuration?.labels?.["openclaw.sandbox"]).toBe("1");
        expect(info?.configuration?.labels?.["openclaw.e2e"]).toBe("1");
      } finally {
        await removeContainer(name);
      }
    },
  );

  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "network none prevents outbound connectivity",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const name = containerName("netno");
      try {
        await createAndStart(name, { network: "none" });

        // wget with a short timeout; expect failure due to no network
        const result = await runAppleContainerCli({
          config: DEFAULT_PLUGIN_CONFIG,
          args: [
            "exec",
            "-i",
            name,
            "/bin/sh",
            "-c",
            "wget -q -O /dev/null --timeout=3 http://1.1.1.1/ 2>&1; echo $?",
          ],
          allowFailure: true,
        });
        const exitStr = result.stdout.toString("utf8").trim().split("\n").pop() ?? "";
        expect(Number(exitStr)).not.toBe(0);
      } finally {
        await removeContainer(name);
      }
    },
  );

  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "inspect returns null for nonexistent container",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const info = await inspectAppleContainer({
        config: DEFAULT_PLUGIN_CONFIG,
        containerId: "openclaw-e2e-nonexistent-container-name",
      });
      expect(info).toBeNull();
    },
  );

  it.runIf(OPENCLAW_APPLE_CONTAINER_E2E)(
    "delete removes the container and inspect returns null",
    { timeout: OPENCLAW_APPLE_CONTAINER_E2E_TIMEOUT_MS },
    async () => {
      if (!(await appleContainerReady())) {
        return;
      }

      const name = containerName("del");
      await createAndStart(name);

      await removeContainer(name);

      const info = await inspectAppleContainer({
        config: DEFAULT_PLUGIN_CONFIG,
        containerId: name,
      });
      expect(info).toBeNull();
    },
  );
});
