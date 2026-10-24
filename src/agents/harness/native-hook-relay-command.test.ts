import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
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

import { buildNativeHookRelayCommand as build } from "./native-hook-relay-command.js";
import { shellQuoteArgs } from "./native-hook-relay-utils.js";

function buildCommand(overrides: Partial<Parameters<typeof build>[0]> = {}) {
  return build({
    provider: "codex",
    relayId: "relay-1",
    event: "post_tool_use",
    ...overrides,
  });
}

function expectedCommand(argv: string[]): string {
  const flags =
    "hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000";
  const command = shellQuoteArgs([...argv, ...flags.split(" ")]);
  return process.platform === "win32" ? command : `exec ${command}`;
}

afterEach(() => {
  mocks.existingPaths.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const relayEntry = path.join(mocks.packageRoot, "dist", "native-hook-relay", "entry.js");
const generalCli = path.join(mocks.packageRoot, "openclaw.mjs");
const override = path.resolve("/custom/openclaw-entry.mjs");
it.each([
  { name: "standalone without a loose entry", standalone: true },
  { name: "isolated packaged relay", entry: relayEntry, extraEntry: generalCli },
  { name: "general CLI fallback", entry: generalCli },
  { name: "explicit CLI override", entry: override, extraEntry: relayEntry, cliOverride: true },
  {
    name: "loose override in a standalone process",
    standalone: true,
    entry: override,
    cliOverride: true,
    nodeExecutable: "/explicit/node",
  },
])("resolves $name", ({ standalone, entry, extraEntry, cliOverride, nodeExecutable }) => {
  if (standalone) {
    vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/standalone/runtime/").href);
  }
  for (const candidate of [entry, extraEntry]) {
    if (candidate) {
      mocks.existingPaths.add(candidate);
    }
  }
  if (cliOverride && entry) {
    vi.stubEnv("OPENCLAW_CLI_PATH", entry);
  }
  const argv = [nodeExecutable ?? process.execPath, ...(entry ? [entry] : [])];
  expect(buildCommand({ nodeExecutable })).toBe(expectedCommand(argv));
});

it.each([
  ["parameter", false],
  ["parameter", true],
  ["environment", false],
  ["environment", true],
] as const)("uses an explicit standalone %s target (relative=%s)", async (source, relative) => {
  await withTempDir("openclaw-relay-standalone-", async (root) => {
    const executable = path.join(root, "renamed-cli");
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
      buildCommand(
        source === "parameter" ? { executable: target, nodeExecutable: "/unused/node" } : {},
      ),
    ).toBe(expectedCommand([executable]));
  });
});
