import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  packageRoot: "/openclaw-package",
}));

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(() => vi.importActual<typeof import("node:fs")>("node:fs"), {
    existsSync: (candidate) => typeof candidate === "string" && mocks.existingPaths.has(candidate),
  });
});

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: () => mocks.packageRoot,
}));

import { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
import { shellQuoteArgs } from "./native-hook-relay-utils.js";

function buildCommand(): string {
  return buildNativeHookRelayCommand({
    provider: "codex",
    relayId: "relay-1",
    event: "post_tool_use",
  });
}

function expectedCommand(argv: string[]): string {
  const command = shellQuoteArgs([
    ...argv,
    "hooks",
    "relay",
    "--provider",
    "codex",
    "--relay-id",
    "relay-1",
    "--event",
    "post_tool_use",
    "--timeout",
    "5000",
  ]);
  return process.platform === "win32" ? command : `exec ${command}`;
}

describe("native hook relay executable resolution", () => {
  beforeEach(() => {
    mocks.existingPaths.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("invokes the standalone executable without any physical loose entry", () => {
    vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/standalone/runtime/").href);

    expect(buildCommand()).toBe(expectedCommand([process.execPath]));
  });

  it.each([
    { source: "parameter", relative: false },
    { source: "parameter", relative: true },
    { source: "environment", relative: false },
    { source: "environment", relative: true },
  ])(
    "uses an explicit standalone $source target (relative=$relative)",
    async ({ source, relative }) => {
      await withTempDir("openclaw-relay-standalone-", async (root) => {
        const executable = path.join(root, "renamed-cli");
        await mkdir(path.join(root, "runtime"));
        await writeFile(executable, "");
        await writeFile(
          path.join(root, "manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            mode: "jit",
            executable: { path: "renamed-cli" },
            runtime: { path: "runtime" },
            openclaw: { version: "2026.10.15" },
            bun: { version: "1.4.3" },
          }),
        );
        const target = relative ? path.relative(process.cwd(), executable) : executable;
        vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/other/runtime/").href);
        if (source === "environment") {
          vi.stubEnv("OPENCLAW_CLI_PATH", target);
          mocks.existingPaths.add(target);
        }
        expect(
          buildNativeHookRelayCommand({
            provider: "codex",
            relayId: "relay-1",
            event: "post_tool_use",
            ...(source === "parameter"
              ? { executable: target, nodeExecutable: "/unused/node" }
              : {}),
          }),
        ).toBe(expectedCommand([executable]));
      });
    },
  );

  it("prefers the isolated packaged relay over the general CLI", () => {
    const relayEntry = path.join(mocks.packageRoot, "dist", "native-hook-relay", "entry.js");
    const generalCli = path.join(mocks.packageRoot, "openclaw.mjs");
    mocks.existingPaths.add(relayEntry);
    mocks.existingPaths.add(generalCli);

    expect(buildCommand()).toBe(expectedCommand([process.execPath, relayEntry]));
  });

  it("falls back to the packaged general CLI when the isolated artifact is absent", () => {
    const generalCli = path.join(mocks.packageRoot, "openclaw.mjs");
    mocks.existingPaths.add(generalCli);

    expect(buildCommand()).toBe(expectedCommand([process.execPath, generalCli]));
  });

  it("preserves the explicit CLI path override", () => {
    const override = path.resolve("/custom/openclaw-entry.mjs");
    vi.stubEnv("OPENCLAW_CLI_PATH", override);
    mocks.existingPaths.add(override);
    mocks.existingPaths.add(path.join(mocks.packageRoot, "dist", "native-hook-relay", "entry.js"));

    expect(buildCommand()).toBe(expectedCommand([process.execPath, override]));
  });

  it("keeps an explicit loose override and its runtime in a standalone process", () => {
    const override = path.resolve("/custom/openclaw-entry.mjs");
    vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/standalone/runtime/").href);
    vi.stubEnv("OPENCLAW_CLI_PATH", override);
    mocks.existingPaths.add(override);

    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        event: "post_tool_use",
        nodeExecutable: "/explicit/node",
      }),
    ).toBe(expectedCommand(["/explicit/node", override]));
  });
});
