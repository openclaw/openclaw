import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchAndExtractSandboxed } from "./sandboxed-fetch.js";
import { registerSandboxExecBridge, pruneSandboxExecBridge } from "./exec-bridge-registry.js";
import type { SandboxBackendCommandParams, SandboxBackendCommandResult } from "./backend-handle.types.js";

// sandboxed-fetch.ts's generated script invokes this fixed path -- it only
// exists because the Dockerfile COPYs the real script there at image build
// time (scripts/docker/sandbox/Dockerfile). Off the container this path is
// absent, so the shim below rewrites it to the real on-disk script file
// (same content, same repo file the image is built from) rather than
// mutating any system directory. Duplicated from sandboxed-fetch.ts's
// SANDBOXED_FETCH_SCRIPT_PATH constant, which is not exported: this is the
// container-install-path contract, mirrored in the Dockerfile COPY target
// too, not something expected to drift silently.
const CONTAINER_SCRIPT_PATH = "/usr/local/bin/openclaw-sandboxed-fetch.py";
const REAL_SCRIPT_PATH = fileURLToPath(
  new URL("../../../scripts/docker/sandbox/openclaw-sandboxed-fetch.py", import.meta.url),
);

// Mirrors fs-bridge.backend.e2e.test.ts's runLocalShellCommand exactly:
// runs the REAL script string produced by sandboxed-fetch.ts against a real
// `sh -c` subprocess on THIS machine (which has python3), proving the real
// script contract without needing a real sandbox container.
async function runLocalShellCommand(
  params: SandboxBackendCommandParams,
): Promise<SandboxBackendCommandResult> {
  const script = params.script.replaceAll(CONTAINER_SCRIPT_PATH, REAL_SCRIPT_PATH);
  return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn("sh", ["-c", script, "openclaw-sandboxed-fetch-test", ...(params.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), code: code ?? 1 });
    });
  });
}

describe("fetchAndExtractSandboxed (local shim, real script logic, no Docker)", () => {
  it("fetches and extracts through the real script when a bridge is registered", async () => {
    registerSandboxExecBridge("test-session-key", { runShellCommand: runLocalShellCommand } as never);
    try {
      const result = await fetchAndExtractSandboxed({
        url: "https://example.com",
        maxChars: 500,
        sandboxExecKey: "test-session-key",
      });
      expect("text" in result).toBe(true);
      if ("text" in result) {
        expect(result.text.length).toBeGreaterThan(0);
      }
    } finally {
      pruneSandboxExecBridge("test-session-key");
    }
  });

  it("blocks a private-IP URL before ever dispatching to the script", async () => {
    registerSandboxExecBridge("test-session-key-2", { runShellCommand: runLocalShellCommand } as never);
    try {
      const result = await fetchAndExtractSandboxed({
        url: "http://192.168.1.1/",
        maxChars: 500,
        sandboxExecKey: "test-session-key-2",
      });
      expect("error" in result).toBe(true);
    } finally {
      pruneSandboxExecBridge("test-session-key-2");
    }
  });
});
