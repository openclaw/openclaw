import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-codex-auth-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function generatedCodexPaths(stateDir: string): {
  configPath: string;
  wrapperPath: string;
} {
  const baseDir = path.join(stateDir, "acpx");
  const codexHome = path.join(baseDir, "codex-home");
  return {
    configPath: path.join(codexHome, "config.toml"),
    wrapperPath: path.join(baseDir, "codex-acp-wrapper.mjs"),
  };
}

function expectCodexWrapperCommand(command: string | undefined, wrapperPath: string): void {
  expect(command).toContain(process.execPath);
  expect(command).toContain(wrapperPath);
}

afterEach(async () => {
  restoreEnv("CODEX_HOME");
  restoreEnv("OPENCLAW_AGENT_DIR");
  restoreEnv("PI_CODING_AGENT_DIR");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prepareAcpxCodexAuthConfig", () => {
  it("installs an isolated Codex ACP wrapper without synthesizing auth from canonical OpenClaw OAuth", async () => {
    const root = await makeTempDir();
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const installedBinPath = path.join(
      root,
      "node_modules",
      "@zed-industries",
      "codex-acp",
      "bin",
      "codex-acp.js",
    );
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_DIR;

    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    await expect(fs.access(generated.wrapperPath)).resolves.toBeUndefined();
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain(JSON.stringify(installedBinPath));
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to the current Codex ACP package range when the local adapter is unavailable", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain('"@zed-industries/codex-acp@^0.12.0"');
    expect(wrapper).toContain('"--", "codex-acp"');
    expect(wrapper).not.toContain("@zed-industries/codex-acp@^0.11.1");
  });

  it("uses the bundled Codex ACP dependency by default when it is installed", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("@zed-industries/codex-acp");
    expect(wrapper).toContain("bin/codex-acp.js");
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
  });

  it("launches the locally installed Codex ACP bin with isolated CODEX_HOME", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const installedBinPath = path.join(root, "codex-acp-bin.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME }));\n",
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    const { stdout } = await execFileAsync(process.execPath, [generated.wrapperPath], {
      cwd: root,
    });
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexHome?: unknown };
    expect(launched.argv).toEqual([]);
    const expectedCodexHome = await fs.realpath(path.join(stateDir, "acpx", "codex-home"));
    expect(path.resolve(String(launched.codexHome))).toBe(expectedCodexHome);
  });

  it("does not copy source Codex auth", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(sourceCodexHome, "config.toml"),
      'notify = ["SkyComputerUseClient", "turn-ended"]\n',
    );
    process.env.CODEX_HOME = sourceCodexHome;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_DIR;

    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex-source", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps an explicitly configured Codex agent command with isolated CODEX_HOME", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "config.toml"),
      'notify = ["SkyComputerUseClient", "turn-ended"]\n',
    );
    process.env.CODEX_HOME = sourceCodexHome;
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command: "npx @zed-industries/codex-acp@0.12.0 -c 'model=\"gpt-5.4\"'",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => path.join(root, "codex-acp.js"),
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    expect(resolved.agents.codex).toContain("npx @zed-industries/codex-acp@0.12.0");
    expect(resolved.agents.codex).toContain("-c 'model=\"gpt-5.4\"'");
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("process.argv.slice(2)");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);
  });
});
