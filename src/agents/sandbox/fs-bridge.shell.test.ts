import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  findCallByScriptFragment,
  getDockerPathArg,
  getScriptsFromCalls,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge shell compatibility", () => {
  installFsBridgeTestHarness();

  it("uses POSIX-safe shell prologue in all bridge commands", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "a.txt" });
    await bridge.writeFile({ filePath: "b.txt", data: "hello" });
    await bridge.mkdirp({ filePath: "nested" });
    await bridge.remove({ filePath: "b.txt" });
    await bridge.rename({ from: "a.txt", to: "c.txt" });
    await bridge.stat({ filePath: "c.txt" });

    expect(mockedExecDockerRaw).toHaveBeenCalled();

    const scripts = getScriptsFromCalls();
    const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

    expect(executables.every((shell) => shell === "sh")).toBe(true);
    expect(scripts.every((script) => /set -eu[;\n]/.test(script))).toBe(true);
    expect(scripts.some((script) => script.includes("pipefail"))).toBe(false);
  });

  it("resolveCanonicalContainerPath script is valid POSIX sh (no do; token)", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "a.txt" });

    const scripts = getScriptsFromCalls();
    const canonicalScript = scripts.find((script) => script.includes("allow_final"));
    expect(canonicalScript).toBeDefined();
    expect(canonicalScript).not.toMatch(/\bdo;/);
    expect(canonicalScript).toMatch(/\bdo\n\s*parent=/);
  });

  it("reads inbound media-style filenames with triple-dash ids", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    const inboundPath = "media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.ogg";

    await bridge.readFile({ filePath: inboundPath });

    const readCall = findCallByScriptFragment('cat -- "$1"');
    expect(readCall).toBeDefined();
    const readPath = readCall ? getDockerPathArg(readCall[0]) : "";
    expect(readPath).toContain("file_1095---");
  });

  it("resolves dash-leading basenames into absolute container paths", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "--leading.txt" });

    const readCall = findCallByScriptFragment('cat -- "$1"');
    expect(readCall).toBeDefined();
    const readPath = readCall ? getDockerPathArg(readCall[0]) : "";
    expect(readPath).toBe("/workspace/--leading.txt");
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await bridge.readFile({ filePath: "/workspace-two/README.md" });

    const args = mockedExecDockerRaw.mock.calls.at(-1)?.[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining(["moltbot-sbx-test", "sh", "-c", 'set -eu; cat -- "$1"']),
    );
    expect(getDockerPathArg(args)).toBe("/workspace-two/README.md");
  });

  it("writes via temp file + atomic rename (never direct truncation)", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.writeFile({ filePath: "b.txt", data: "hello" });

    const scripts = getScriptsFromCalls();
    expect(scripts.some((script) => script.includes('cat >"$1"'))).toBe(false);
    expect(scripts.some((script) => script.includes('cat >"$tmp"'))).toBe(true);
    expect(scripts.some((script) => script.includes('mv -f -- "$1" "$2"'))).toBe(true);
  });

  it("re-validates target before final rename and cleans temp file on failure", async () => {
    const { mockedOpenBoundaryFile } = await import("./fs-bridge.test-helpers.js");
    mockedOpenBoundaryFile
      .mockImplementationOnce(async () => ({ ok: false, reason: "path" }))
      .mockImplementationOnce(async () => ({
        ok: false,
        reason: "validation",
        error: new Error("Hardlinked path is not allowed"),
      }));

    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
      /hardlinked path/i,
    );

    const scripts = getScriptsFromCalls();
    expect(scripts.some((script) => script.includes("mktemp"))).toBe(true);
    expect(scripts.some((script) => script.includes('mv -f -- "$1" "$2"'))).toBe(false);
    expect(scripts.some((script) => script.includes('rm -f -- "$1"'))).toBe(true);
  });
});
