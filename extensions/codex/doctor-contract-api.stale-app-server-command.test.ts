import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { safePathSegmentHashed } from "@openclaw/fs-safe/advanced";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { resolveRuntimeForTest } from "./src/app-server/config.test-support.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CODEX_GENERATION_PREFIX = `${safePathSegmentHashed(
  "@openclaw/codex",
)}__openclaw-generation__`;
const GENERATION_SUFFIX = "g-0123456789abcdef";
const OTHER_GENERATION_SUFFIX = "g-fedcba9876543210";
const REMOVAL_CHANGE =
  "Removed plugins.entries.codex.config.appServer.command; it pointed into an OpenClaw-managed Codex plugin generation that no longer exists. Without it, stdio Codex app-server starts use managed binary selection (or OPENCLAW_CODEX_APP_SERVER_BIN when set).";
const CYBER_FAILOVER_CHANGE =
  "Removed retired plugins.entries.codex.config.appServer.cyberFailover.model; automatic cyber-policy retries use the active model through approved Daybreak access. Existing mode and cooloffMs settings were not changed.";

function generationName(suffix = GENERATION_SUFFIX): string {
  return `${CODEX_GENERATION_PREFIX}${suffix}`;
}

function createConfig(command: unknown) {
  return {
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              command,
              args: ["app-server", "--listen", "stdio://"],
              approvalPolicy: "never",
              sandbox: "workspace-write",
            },
          },
        },
      },
    },
  };
}

async function createFixture() {
  const root = tempDirs.make("openclaw-codex-stale-command-");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_BIN", "");
  return {
    root,
    stateDir,
    projectsDir: path.join(stateDir, "npm", "projects"),
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const outsideCommandCases: Array<{
  name: string;
  command: (fixture: Fixture) => unknown;
}> = [
  {
    name: "an absolute custom command outside the managed root",
    command: () => "/operator/codex",
  },
  {
    name: "a missing custom command outside the managed root",
    command: ({ root }) => path.join(root, "elsewhere", "codex"),
  },
  {
    name: "a same-shaped command outside the managed root",
    command: ({ root }) =>
      path.join(root, "other", "npm", "projects", generationName(), "bin", "codex"),
  },
];

const managedShapeCases: Array<{
  name: string;
  command: (fixture: Fixture) => unknown;
}> = [
  {
    name: "another package generation",
    command: ({ projectsDir }) => {
      const otherPackagePrefix = `${safePathSegmentHashed(
        "@openclaw/other",
      )}__openclaw-generation__`;
      return path.join(projectsDir, `${otherPackagePrefix}${GENERATION_SUFFIX}`, "bin", "tool");
    },
  },
  {
    name: "a flat Codex project",
    command: ({ projectsDir }) =>
      path.join(projectsDir, safePathSegmentHashed("@openclaw/codex"), "bin", "codex"),
  },
  {
    name: "the generation project directory itself",
    command: ({ projectsDir }) => path.join(projectsDir, generationName()),
  },
];

afterEach(async () => {
  vi.unstubAllEnvs();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const statSync = vi.mocked(fsSync.statSync);
  statSync.mockReset();
  statSync.mockImplementation(actual.statSync);
});

describe("Codex stale managed app-server command Doctor repair", () => {
  it("removes a missing managed generation command and restores managed selection", async () => {
    const { projectsDir } = await createFixture();
    const command = path.join(
      projectsDir,
      generationName(),
      "node_modules",
      "@openai",
      "codex-linux-x64",
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
      "codex",
    );
    const original = createConfig(command);
    const before = structuredClone(original);

    const result = normalizeCompatibilityConfig({
      cfg: original as OpenClawConfig,
    });

    expect(result.changes).toEqual([REMOVAL_CHANGE]);
    expect(result.config.plugins?.entries?.codex?.config?.appServer).toEqual({
      args: ["app-server", "--listen", "stdio://"],
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(original).toEqual(before);

    const repeated = normalizeCompatibilityConfig({ cfg: result.config });
    expect(repeated.config).toBe(result.config);
    expect(repeated.changes).toEqual([]);

    const runtime = resolveRuntimeForTest({
      pluginConfig: result.config.plugins?.entries?.codex?.config,
    });
    expect(runtime.start.commandSource).toBe("managed");
  });

  it.each(outsideCommandCases)("keeps $name", async ({ command }) => {
    const fixture = await createFixture();
    const config = createConfig(command(fixture));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it("keeps a command while its managed generation project exists", async () => {
    const { projectsDir } = await createFixture();
    const projectDir = path.join(projectsDir, generationName());
    await fs.mkdir(projectDir, { recursive: true });
    const config = createConfig(path.join(projectDir, "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it.each(managedShapeCases)("keeps $name", async ({ command }) => {
    const fixture = await createFixture();
    const config = createConfig(command(fixture));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it.each([
    { suffix: `g-${"a".repeat(15)}` },
    { suffix: `g-${"a".repeat(17)}` },
    { suffix: "g-0123456789abcdeF" },
    { suffix: "g-0123456789abcdef-extra" },
  ])("keeps malformed generation suffix $suffix", async ({ suffix }) => {
    const { projectsDir } = await createFixture();
    const config = createConfig(path.join(projectsDir, generationName(suffix), "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it("removes a home-relative managed generation command", async () => {
    const fixture = await createFixture();
    vi.stubEnv("OPENCLAW_HOME", fixture.root);
    const config = createConfig(
      path.join("~", "state", "npm", "projects", generationName(), "bin", "codex"),
    );

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
    expect(result.changes).toEqual([REMOVAL_CHANGE]);
  });

  it("removes a dot-normalized managed generation command", async () => {
    const { projectsDir } = await createFixture();
    const command =
      `${path.join(projectsDir, "x")}${path.sep}..${path.sep}` +
      `${generationName()}${path.sep}bin${path.sep}codex`;
    const config = createConfig(command);

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
    expect(result.changes).toEqual([REMOVAL_CHANGE]);
  });

  it("keeps a normalized path that escapes the managed root", async () => {
    const { projectsDir } = await createFixture();
    const command =
      `${path.join(projectsDir, generationName())}${path.sep}..${path.sep}` +
      `..${path.sep}outside${path.sep}codex`;
    const config = createConfig(command);

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it.each([
    { name: "a relative command", command: "relative/codex" },
    { name: "a bare command", command: "codex" },
    { name: "an unsupported tilde command", command: "~operator/codex" },
    { name: "a numeric command", command: 17 },
    { name: "a null command", command: null },
  ])("keeps $name", async ({ command }) => {
    await createFixture();
    const config = createConfig(command);

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a POSIX filename containing Windows separators",
    async () => {
      const { projectsDir } = await createFixture();
      const command = `${projectsDir}\\${generationName()}\\bin\\codex`;
      const config = createConfig(command);

      const result = normalizeCompatibilityConfig({
        cfg: config as OpenClawConfig,
      });

      expect(result.config).toBe(config);
      expect(result.changes).toEqual([]);
    },
  );

  it("keeps a generation symlink that resolves to an existing directory", async () => {
    const { root, projectsDir } = await createFixture();
    const externalDir = path.join(root, "external-generation");
    const projectDir = path.join(projectsDir, generationName());
    await fs.mkdir(externalDir, { recursive: true });
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.symlink(externalDir, projectDir, process.platform === "win32" ? "junction" : "dir");
    const config = createConfig(path.join(projectDir, "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it("removes a command below a dangling generation symlink", async () => {
    const { root, projectsDir } = await createFixture();
    const missingTarget = path.join(root, "missing-generation");
    const projectDir = path.join(projectsDir, generationName());
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.symlink(missingTarget, projectDir, process.platform === "win32" ? "junction" : "dir");
    const config = createConfig(path.join(projectDir, "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
    expect(result.changes).toEqual([REMOVAL_CHANGE]);
  });

  it.each([
    {
      name: "the command when statSync throws EACCES",
      error: Object.assign(new Error("permission denied"), {
        code: "EACCES",
      }),
    },
    {
      name: "the command when statSync throws an ordinary Error",
      error: new Error("unexpected stat failure"),
    },
  ])("keeps $name", async ({ error }) => {
    const { projectsDir } = await createFixture();
    vi.mocked(fsSync.statSync).mockImplementationOnce(() => {
      throw error;
    });
    const config = createConfig(path.join(projectsDir, generationName(), "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });

  it("removes the command when statSync throws ENOTDIR", async () => {
    const { projectsDir } = await createFixture();
    vi.mocked(fsSync.statSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("not a directory"), {
        code: "ENOTDIR",
      });
    });
    const config = createConfig(path.join(projectsDir, generationName(), "bin", "codex"));

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config.plugins?.entries?.codex?.config?.appServer).not.toHaveProperty("command");
    expect(result.changes).toEqual([REMOVAL_CHANGE]);
  });

  it("removes a stale managed command and a retired cyber-failover model together", async () => {
    const { projectsDir } = await createFixture();
    const config = createConfig(
      path.join(projectsDir, generationName(OTHER_GENERATION_SUFFIX), "bin", "codex"),
    );
    Object.assign(config.plugins.entries.codex.config.appServer, {
      cyberFailover: {
        model: "retired-model",
        mode: "auto",
        cooloffMs: 5000,
      },
    });

    const result = normalizeCompatibilityConfig({
      cfg: config as OpenClawConfig,
    });

    expect(result.config.plugins?.entries?.codex?.config?.appServer).toEqual({
      args: ["app-server", "--listen", "stdio://"],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      cyberFailover: {
        mode: "auto",
        cooloffMs: 5000,
      },
    });
    expect(result.changes).toEqual([REMOVAL_CHANGE, CYBER_FAILOVER_CHANGE]);
  });
});
