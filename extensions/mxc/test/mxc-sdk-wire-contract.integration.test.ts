import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveMxcBinaryPath } from "../src/binary-resolver.js";
import type { MxcConfig } from "../src/config.js";
import { createMxcSandboxBackendHandle } from "../src/mxc-backend.js";
import { assertMxcReadiness } from "../src/readiness.js";

// The plugin hands MXC a raw ContainerConfig, so the pinned executor's wire
// parser is the contract. `wxc-exec --dry-run` parses and validates the config
// without creating a container or running the command.
const describeOnWindows = describe.runIf(process.platform === "win32");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function readLauncherPayload(argv: readonly string[]): {
  config: Record<string, unknown>;
  options: { executablePath: string };
} {
  const payloadFile = argv[argv.indexOf("--payload-file") + 1];
  if (!payloadFile) {
    throw new Error(`expected --payload-file in argv: ${JSON.stringify(argv)}`);
  }
  return JSON.parse(readFileSync(payloadFile, "utf-8"));
}

function dryRunConfig(
  executablePath: string,
  config: Record<string, unknown>,
): { exitCode: number; output: string } {
  const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
  try {
    const output = execFileSync(executablePath, ["--dry-run", "--config-base64", configBase64], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30_000,
      windowsHide: true,
    });
    return { exitCode: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.status ?? -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describeOnWindows("MXC SDK wire contract", () => {
  test("readiness accepts the pinned wxc-exec host probe", () => {
    const executablePath = resolveMxcBinaryPath();

    expect(() => assertMxcReadiness({ executablePath, platform: "win32" })).not.toThrow();
  });

  test.each([
    { name: "no workspace access, blocked network", network: "none", workspaceAccess: "none" },
    { name: "read-write workspace, default network", network: "default", workspaceAccess: "rw" },
  ] as const)("pinned wxc-exec accepts the generated config ($name)", async (variant) => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-wire-contract-"));
    tempDirs.push(root);
    const workdir = path.join(root, "sandbox");
    const agentWorkspaceDir = path.join(root, "workspace");
    mkdirSync(workdir);
    mkdirSync(agentWorkspaceDir);
    const config: MxcConfig = {
      containment: "process",
      network: variant.network,
      timeoutSeconds: 30,
      timeoutSecondsConfigured: true,
      debug: false,
    };

    const handle = createMxcSandboxBackendHandle({
      config,
      runtimeId: "openclaw-mxc-wire-contract",
      workdir,
      agentWorkspaceDir,
      workspaceAccess: variant.workspaceAccess,
    });
    const spec = await handle.buildExecSpec({ command: "echo contract", env: {}, usePty: false });
    let validation: { exitCode: number; output: string };
    try {
      const payload = readLauncherPayload(spec.argv);
      validation = dryRunConfig(payload.options.executablePath, payload.config);
    } finally {
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
    }
    expect(validation).toEqual({ exitCode: 0, output: expect.any(String) });
  });
});
