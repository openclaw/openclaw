import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, test } from "vitest";
import { resolveMxcBinaryPath } from "../src/binary-resolver.js";
import { resolveConfig } from "../src/config.js";
import { createMxcSandboxBackendHandle } from "../src/mxc-backend.js";
import { assertMxcReadiness } from "../src/readiness.js";

// Validate raw ContainerConfig with the real executor, without creating a container.
const describeOnWindows = describe.runIf(process.platform === "win32");

describeOnWindows("MXC SDK wire contract", () => {
  test("readiness accepts the pinned wxc-exec host probe", () => {
    expect(() => assertMxcReadiness({ executablePath: resolveMxcBinaryPath() })).not.toThrow();
  });

  test.each([
    { name: "no workspace access, blocked network", network: "none", workspaceAccess: "none" },
    { name: "read-write workspace, default network", network: "default", workspaceAccess: "rw" },
  ] as const)("pinned wxc-exec accepts the generated config ($name)", async (variant) => {
    await using root = await tempWorkspace({ rootDir: tmpdir(), prefix: "mxc-wire-contract-" });
    const workdir = path.join(root.dir, "sandbox");
    const agentWorkspaceDir = path.join(root.dir, "workspace");
    mkdirSync(workdir);
    mkdirSync(agentWorkspaceDir);
    const handle = createMxcSandboxBackendHandle({
      config: resolveConfig({ network: variant.network, timeoutSeconds: 30 }),
      runtimeId: "openclaw-mxc-wire-contract",
      workdir,
      agentWorkspaceDir,
      workspaceAccess: variant.workspaceAccess,
    });
    const spec = await handle.buildExecSpec({ command: "echo contract", env: {}, usePty: false });
    try {
      const file = spec.argv[spec.argv.indexOf("--payload-file") + 1] ?? "";
      const payload: { config: Record<string, unknown>; options: { executablePath: string } } =
        JSON.parse(readFileSync(file, "utf-8"));
      const configBase64 = Buffer.from(JSON.stringify(payload.config)).toString("base64");
      // execFileSync throws on nonzero exit, preserving the wire acceptance assertion.
      expect(
        execFileSync(
          payload.options.executablePath,
          ["--dry-run", "--config-base64", configBase64],
          { encoding: "utf-8", stdio: "pipe", timeout: 30_000, windowsHide: true },
        ),
      ).toEqual(expect.any(String));
    } finally {
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
    }
  });
});
