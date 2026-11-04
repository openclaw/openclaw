import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { standaloneManifestFixture } from "../../daemon/standalone-manifest.test-support.js";
import { withTempDir } from "../../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({ packageRoot: "" }));
vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: () => mocks.packageRoot,
}));
import { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
import { shellQuoteArgs } from "./native-hook-relay-utils.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const worker = "dist/native-hook-relay/entry.js";
const flags =
  "hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000";
it.each([
  { name: "standalone without a loose entry", standalone: true },
  { name: "isolated packaged relay", entry: worker, extra: "openclaw.mjs" },
  { name: "general CLI fallback", entry: "openclaw.mjs" },
  { name: "explicit CLI override", entry: "custom.mjs", extra: worker, env: true },
  { name: "loose override in standalone", entry: "custom.mjs", env: true, standalone: true },
  { name: "relative standalone parameter", entry: "renamed-cli", manifest: true, relative: true },
  { name: "absolute standalone environment", entry: "renamed-cli", manifest: true, env: true },
])("resolves $name", async ({ entry, extra, env, standalone, manifest, relative }) => {
  await withTempDir("openclaw-relay-command-", async (root) => {
    mocks.packageRoot = root;
    for (const file of [entry, extra]) {
      if (file) {
        const filename = path.join(root, file);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, "");
      }
    }
    if (manifest) {
      await writeFile(
        path.join(root, "manifest.json"),
        JSON.stringify(standaloneManifestFixture("jit", "renamed-cli", "2026.10.15", "1.4.3")),
      );
    }
    if (standalone || manifest) {
      vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL("/other/runtime/").href);
    }
    const executable = entry ? path.join(root, entry) : undefined;
    const target = relative && executable ? path.relative(process.cwd(), executable) : executable;
    if (env) {
      vi.stubEnv("OPENCLAW_CLI_PATH", target);
    }
    const nodeExecutable = standalone && entry ? "/explicit/node" : process.execPath;
    const argv = manifest ? [executable!] : [nodeExecutable, ...(executable ? [executable] : [])];
    const command = shellQuoteArgs([...argv, ...flags.split(" ")]);
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        event: "post_tool_use",
        nodeExecutable: manifest ? "/unused/node" : nodeExecutable,
        ...(manifest && !env ? { executable: target } : {}),
      }),
    ).toBe(process.platform === "win32" ? command : `exec ${command}`);
  });
});
