import type { PathLike } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { probeCodexAppServerHandshake } from "./installed-probe.js";

const fixture = vi.hoisted(() => ({ blockedPath: "" }));
const originalPlatform = process.platform;
const portablePlatform = originalPlatform === "darwin" ? "linux" : originalPlatform;
const missingPreferences = {
  stdout: "",
  stderr: "Error: Domain 'com.openai.codex' not found.",
  code: 1,
  signal: null,
  killed: false,
  termination: "exit" as const,
};
const programData = { ...missingPreferences, stdout: "C:\\ProgramData", stderr: "", code: 0 };
function mockCommand(result = missingPreferences) {
  return vi.spyOn(processRuntime, "runUtf8CommandWithTimeout").mockResolvedValue(result);
}
function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
  if (platform === "win32" || platform === "darwin") {
    return mockCommand(platform === "win32" ? programData : missingPreferences);
  }
  return undefined;
}
// mock-isolation: never read or depend on the host's managed Codex configuration.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    access(file: PathLike, mode?: number) {
      const normalized = typeof file === "string" ? file.replaceAll("\\", "/") : undefined;
      if (
        normalized === "/etc/codex/managed_config.toml" ||
        normalized === "/etc/codex/requirements.toml" ||
        normalized === "C:/ProgramData/OpenAI/Codex/requirements.toml"
      ) {
        return normalized === fixture.blockedPath
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error("absent fixture"), { code: "ENOENT" }));
      }
      return actual.access(file, mode);
    },
  };
});

beforeEach(() => {
  fixture.blockedPath = "";
  setPlatform(portablePlatform);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.unstubAllEnvs();
});

it.each([
  ["environment", portablePlatform],
  ["system configuration", portablePlatform],
  ...(originalPlatform === "win32" ? [] : [["an absent macOS preferences domain", "darwin"]]),
])(
  "isolates Codex SQLite state from %s during the selection handshake",
  async (source, platform) => {
    setPlatform(platform);
    await withTempDir("openclaw-installed-probe-", async (root) => {
      const existingHome = path.join(root, "existing-codex-state");
      const observedPath = path.join(root, "observed.json");
      const command = path.join(root, "codex-fixture.cjs");
      await mkdir(existingHome);
      await writeFile(
        command,
        `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const home = process.env.CODEX_HOME;
const configured = ${source === "system configuration" ? JSON.stringify(existingHome) : "undefined"};
const overrideIndex = process.argv.indexOf("-c");
const override = overrideIndex < 0 ? undefined : process.argv[overrideIndex + 1];
const sqlite = override?.startsWith("sqlite_home=")
  ? JSON.parse(override.slice("sqlite_home=".length))
  : (configured ?? process.env.CODEX_SQLITE_HOME);
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({home, sqlite}));
fs.writeFileSync(path.join(sqlite, "opened-database"), "selection probe");
readline.createInterface({input: process.stdin}).once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id: request.id, result: {userAgent: "codex-cli/0.162.1"}}) + "\\n");
});
`,
      );
      vi.stubEnv("CODEX_HOME", existingHome);
      vi.stubEnv("CODEX_SQLITE_HOME", existingHome);

      await expect(probeCodexAppServerHandshake(command)).resolves.toBe("0.162.1");

      const observed = JSON.parse(await readFile(observedPath, "utf8")) as {
        home: string;
        sqlite: string;
      };
      expect(observed.home).not.toBe(existingHome);
      expect(observed.sqlite).toBe(observed.home);
      expect(await readdir(existingHome)).toEqual([]);
      await expect(access(observed.home)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it.each([
  ["linux", "/etc/codex/managed_config.toml"],
  ["linux", "/etc/codex/requirements.toml"],
  ["win32", "C:/ProgramData/OpenAI/Codex/requirements.toml"],
  ["darwin", "config_toml_base64"],
  ["darwin", "requirements_toml_base64"],
])("does not launch a selection probe under managed %s %s", async (platform, target) => {
  const command = setPlatform(platform);
  fixture.blockedPath = target;
  if (platform === "darwin") {
    command?.mockImplementation(async (argv) =>
      argv.at(-1) === target
        ? { ...missingPreferences, code: 0, stdout: "Type is string", stderr: "" }
        : {
            ...missingPreferences,
            stderr: `Error: Could not find key '${argv.at(-1)}' in domain 'com.openai.codex'.`,
          },
    );
  }
  await expect(probeCodexAppServerHandshake(process.execPath)).rejects.toThrow(
    platform === "darwin"
      ? "managed Codex preferences cannot be excluded from the selection probe"
      : "managed Codex configuration prevents an isolated selection probe",
  );
});
