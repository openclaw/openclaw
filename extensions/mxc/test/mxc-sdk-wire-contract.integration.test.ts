import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probe, type ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { afterEach, describe, expect, test } from "vitest";
import { buildMxcNativeEnv, resolveMxcNativeBinaries } from "../src/binary-resolver.js";
import type { MxcConfig } from "../src/config.js";
import { createMxcSandboxBackendHandle } from "../src/mxc-backend.js";
import { resolveMxcLauncherPath } from "../src/plugin-root.js";
import { buildLauncherEnv } from "../src/windows-env.js";

// Exercises the generated v1 request against the installed MXC SDK 1.0 native
// components: the SDK validates it through mxc_ffi, and the real launcher runs it.
const describeOnWindows = describe.runIf(process.platform === "win32");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function readLauncherRequest(argv: readonly string[]): ContainerRequest {
  const payloadFile = argv[argv.indexOf("--payload-file") + 1];
  if (!payloadFile) {
    throw new Error(`expected --payload-file in argv: ${JSON.stringify(argv)}`);
  }
  return (JSON.parse(readFileSync(payloadFile, "utf-8")) as { request: ContainerRequest })
    .request;
}

describeOnWindows("MXC SDK 1.0 request contract", () => {
  test("the launcher probe loads the pinned native components", () => {
    const output = execFileSync(process.execPath, [resolveMxcLauncherPath(), "--probe"], {
      encoding: "utf-8",
      env: buildLauncherEnv(buildMxcNativeEnv(resolveMxcNativeBinaries())),
      timeout: 30_000,
      windowsHide: true,
    });
    const result = JSON.parse(output) as {
      probe: { tier?: string; error?: string };
    };

    expect(result.probe.error).toBeUndefined();
    expect(result.probe.tier).toEqual(expect.any(String));
  });

  test.each([
    { name: "no workspace access, blocked network", network: "none", workspaceAccess: "none" },
    { name: "read-write workspace, default network", network: "default", workspaceAccess: "rw" },
  ] as const)("MXC accepts and runs the generated request ($name)", async (variant) => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-request-contract-"));
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
      runtimeId: "openclaw-mxc-request-contract",
      workdir,
      agentWorkspaceDir,
      workspaceAccess: variant.workspaceAccess,
    });
    const spec = await handle.buildExecSpec({ command: "echo contract", env: {}, usePty: false });
    let run: ReturnType<typeof spawnSync>;
    try {
      const requestProbe = probe(readLauncherRequest(spec.argv));
      expect(requestProbe.error).toBeUndefined();
      run = spawnSync(spec.argv[0] ?? "", spec.argv.slice(1), {
        encoding: "utf-8",
        env: spec.env,
        timeout: 60_000,
        windowsHide: true,
      });
    } finally {
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
    }

    expect({ status: run.status, stdout: String(run.stdout).trim() }).toEqual({
      status: 0,
      stdout: "contract",
    });
  });
});