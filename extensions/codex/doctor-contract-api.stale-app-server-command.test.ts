import * as fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { resolveRuntimeForTest } from "./src/app-server/config.test-support.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Historical on-disk fixture, independent of the current install-name generator.
const generation = "openclaw-codex-8902d781d4__openclaw-generation__g-0123456789abcdef";
let root: string;
let project: string;

beforeEach(() => {
  root = tempDirs.make("codex-recovery-");
  project = path.join(root, "npm", "projects", generation);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_BIN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(fs.statSync).mockReset();
});

function config(command: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        codex: {
          config: {
            appServer: { command, args: ["app-server"], sandbox: "read-only" },
          },
        },
      },
    },
  };
}

it.each(["absolute", "home-relative"])("repairs an already-deleted generation (%s)", (form) => {
  const command =
    form === "absolute"
      ? path.join(project, "bin", "codex")
      : path.join("~", "npm", "projects", generation, "bin", "codex");
  const original = config(command);
  const result = normalizeCompatibilityConfig({ cfg: original });
  expect(result.config.plugins?.entries?.codex?.config?.appServer).toEqual({
    args: ["app-server"],
    sandbox: "read-only",
  });
  expect(original).toEqual(config(command));
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toContain("generation that no longer exists");
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
  expect(
    resolveRuntimeForTest({ pluginConfig: result.config.plugins?.entries?.codex?.config }).start
      .commandSource,
  ).toBe("managed");
});

it("preserves a pin while its generation exists, even if the executable is missing", () => {
  fs.mkdirSync(project, { recursive: true });
  const cfg = config(path.join(project, "bin", "codex"));
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});

it.each([true, false])("follows generation symlinks (target exists: %s)", (exists) => {
  const target = path.join(root, "target");
  if (exists) {
    fs.mkdirSync(target);
  }
  fs.mkdirSync(path.dirname(project), { recursive: true });
  fs.symlinkSync(target, project, process.platform === "win32" ? "junction" : "dir");
  const cfg = config(path.join(project, "bin", "codex"));
  const result = normalizeCompatibilityConfig({ cfg });
  if (exists) {
    expect(result).toEqual({ config: cfg, changes: [] });
  } else {
    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
  }
});

it.each([
  "codex",
  "relative/codex",
  "~operator/codex",
  17,
  null,
  "/operator/codex", // Missing custom command, not a managed generation.
  "npm/projects/openclaw-codex-8902d781d4/bin/codex", // Flat managed install.
  `other/projects/${generation}/bin/codex`, // Correct shape, wrong root.
  `npm/projects/${generation}`, // The generation itself is not an executable within it.
  `npm/projects/${generation}-extra/bin/codex`, // Not an exact generation name.
  `npm/projects/${generation.replace("codex", "other")}/bin/tool`,
  `npm/projects/${generation}/../../../outside/codex`, // Normalizes outside the root.
])("preserves unrelated command %s", (value) => {
  const command =
    typeof value === "string" && /^(npm|other)\//u.test(value) ? path.join(root, value) : value;
  const cfg = config(command);
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});

it.each(["ENOENT", "ENOTDIR", "EACCES", "EIO"])("handles filesystem result %s", (code) => {
  vi.mocked(fs.statSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(code), { code });
  });
  const cfg = config(path.join(project, "bin", "codex"));
  const result = normalizeCompatibilityConfig({ cfg });
  if (code === "ENOENT" || code === "ENOTDIR") {
    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
    expect(result.changes).toHaveLength(1);
  } else {
    expect(result).toEqual({ config: cfg, changes: [] });
  }
});
