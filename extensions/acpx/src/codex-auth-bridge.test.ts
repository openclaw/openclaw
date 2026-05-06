import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function quoteArg(value: string): string {
  return JSON.stringify(value);
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

function generatedClaudePaths(stateDir: string): {
  wrapperPath: string;
} {
  const baseDir = path.join(stateDir, "acpx");
  return {
    wrapperPath: path.join(baseDir, "claude-agent-acp-wrapper.mjs"),
  };
}

function expectCodexWrapperCommand(command: string | undefined, wrapperPath: string): void {
  expect(command).toContain(quoteArg(process.execPath));
  expect(command).toContain(quoteArg(wrapperPath));
}

function expectClaudeWrapperCommand(command: string | undefined, wrapperPath: string): void {
  expect(command).toContain(quoteArg(process.execPath));
  expect(command).toContain(quoteArg(wrapperPath));
}

function expectWrapperToContainPathSuffix(wrapper: string, pathSuffix: string[]): void {
  const nativeSuffix = pathSuffix.join(path.sep);
  const escapedNativeSuffix = JSON.stringify(nativeSuffix).slice(1, -1);
  const posixSuffix = pathSuffix.join("/");
  expect(wrapper.includes(escapedNativeSuffix) || wrapper.includes(posixSuffix)).toBe(true);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64url")
    .replace(/=+$/u, "");
}

function fakeChatgptJwt(params: {
  email: string;
  accountId: string;
  planType: string;
  exp?: number;
}): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      exp: params.exp ?? 2_000_000_000,
      "https://api.openai.com/profile": { email: params.email },
      "https://api.openai.com/auth": {
        chatgpt_account_id: params.accountId,
        chatgpt_plan_type: params.planType,
        chatgpt_user_id: "user-id",
      },
    }),
    "sig",
  ].join(".");
}

afterEach(async () => {
  vi.restoreAllMocks();
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
    const generatedClaude = generatedClaudePaths(stateDir);
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
    expectClaudeWrapperCommand(resolved.agents.claude, generatedClaude.wrapperPath);
    await expect(fs.access(generated.wrapperPath)).resolves.toBeUndefined();
    await expect(fs.access(generatedClaude.wrapperPath)).resolves.toBeUndefined();
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain(JSON.stringify(installedBinPath));
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps generated wrappers usable when chmod is rejected by the state filesystem", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generatedCodex = generatedCodexPaths(stateDir);
    const generatedClaude = generatedClaudePaths(stateDir);
    const chmodError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const chmodSpy = vi.spyOn(fs, "chmod").mockRejectedValue(chmodError);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    expect(chmodSpy).toHaveBeenCalledWith(generatedCodex.wrapperPath, 0o755);
    expect(chmodSpy).toHaveBeenCalledWith(generatedClaude.wrapperPath, 0o755);
    expectCodexWrapperCommand(resolved.agents.codex, generatedCodex.wrapperPath);
    expectClaudeWrapperCommand(resolved.agents.claude, generatedClaude.wrapperPath);
    await expect(fs.access(generatedCodex.wrapperPath)).resolves.toBeUndefined();
    await expect(fs.access(generatedClaude.wrapperPath)).resolves.toBeUndefined();
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
    expect(wrapper).toContain('"@zed-industries/codex-acp@0.13.0"');
    expect(wrapper).toContain('"--", "codex-acp"');
    expect(wrapper).not.toContain("@zed-industries/codex-acp@^0.11.1");
  });

  it("falls back to the patched Claude ACP package when the local adapter is unavailable", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => undefined,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain('"@agentclientprotocol/claude-agent-acp@0.32.0"');
    expect(wrapper).toContain('"--", "claude-agent-acp"');
    expect(wrapper).not.toContain("@agentclientprotocol/claude-agent-acp@^0.31.0");
    expect(wrapper).not.toContain("@agentclientprotocol/claude-agent-acp@0.31.0");
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
    expectWrapperToContainPathSuffix(wrapper, ["bin", "codex-acp.js"]);
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
  });

  it("uses the bundled Claude ACP dependency by default when it is installed", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("@agentclientprotocol/claude-agent-acp");
    expectWrapperToContainPathSuffix(wrapper, ["dist", "index.js"]);
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

  it("syncs Docker OpenClaw openai-codex OAuth into isolated Codex ACP auth", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const generated = generatedCodexPaths(stateDir);
    const accountId = "workspace-123";
    const access = fakeChatgptJwt({
      email: "user@example.com",
      accountId,
      planType: "team",
    });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:user@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access,
              refresh: "refresh-token",
              email: "user@example.com",
              accountId,
              chatgptPlanType: "team",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(agentDir, "auth-state.json"),
      `${JSON.stringify(
        { version: 1, lastGood: { "openai-codex": "openai-codex:user@example.com" } },
        null,
        2,
      )}\n`,
    );
    const installedBinPath = path.join(root, "codex-acp-bin.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ codexHome: process.env.CODEX_HOME }));\n",
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

    await execFileAsync(process.execPath, [generated.wrapperPath], { cwd: root });
    const auth = JSON.parse(
      await fs.readFile(path.join(stateDir, "acpx", "codex-home", "auth.json"), "utf8"),
    ) as {
      auth_mode?: unknown;
      OPENAI_API_KEY?: unknown;
      tokens?: Record<string, unknown>;
    };
    expect(auth.auth_mode).toBe("chatgpt");
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens?.id_token).toBe(access);
    expect(auth.tokens?.access_token).toBe(access);
    expect(auth.tokens?.refresh_token).toBe("refresh-token");
    expect(auth.tokens?.account_id).toBe(accountId);
    await expect(
      fs.access(path.join(stateDir, "acpx", "sync-codex-auth-from-openclaw.mjs")),
    ).resolves.toBeUndefined();
  });

  it("ignores malformed Docker OpenClaw auth state while syncing Codex ACP auth", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const generated = generatedCodexPaths(stateDir);
    const accountId = "workspace-first";
    const access = fakeChatgptJwt({
      email: "first@example.com",
      accountId,
      planType: "team",
    });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:first@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access,
              refresh: "first-refresh-token",
              email: "first@example.com",
              accountId,
              chatgptPlanType: "team",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(agentDir, "auth-state.json"), "{not-json", "utf8");
    const installedBinPath = path.join(root, "codex-acp-bin.js");
    await fs.writeFile(installedBinPath, "console.log('launched');\n", "utf8");
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    const { stderr } = await execFileAsync(process.execPath, [generated.wrapperPath], {
      cwd: root,
    });
    const auth = JSON.parse(
      await fs.readFile(path.join(stateDir, "acpx", "codex-home", "auth.json"), "utf8"),
    ) as { tokens?: Record<string, unknown> };
    expect(auth.tokens?.account_id).toBe(accountId);
    expect(auth.tokens?.refresh_token).toBe("first-refresh-token");
    expect(stderr).toContain("ignored unreadable Docker OpenClaw auth state");
  });

  it("adopts rotated isolated Codex ACP OAuth back into the Docker OpenClaw profile", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const generated = generatedCodexPaths(stateDir);
    const accountId = "workspace-rotated";
    const oldAccess = fakeChatgptJwt({
      email: "user@example.com",
      accountId,
      planType: "team",
      exp: 2_000_000_000,
    });
    const rotatedAccess = fakeChatgptJwt({
      email: "user@example.com",
      accountId,
      planType: "team",
      exp: 2_000_000_900,
    });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:user@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access: oldAccess,
              refresh: "old-refresh-token",
              expires: 2_000_000_000_000,
              email: "user@example.com",
              accountId,
              chatgptPlanType: "team",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(agentDir, "auth-state.json"),
      `${JSON.stringify(
        { version: 1, lastGood: { "openai-codex": "openai-codex:user@example.com" } },
        null,
        2,
      )}\n`,
    );
    const installedBinPath = path.join(root, "codex-acp-bin.js");
    await fs.writeFile(installedBinPath, "console.log('launched');\n", "utf8");
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });
    await fs.writeFile(
      installedBinPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `const auth = ${JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            id_token: "rotated-id-token",
            access_token: rotatedAccess,
            refresh_token: "rotated-refresh-token",
            account_id: accountId,
          },
          last_refresh: "2033-05-18T03:33:20.000Z",
        })};`,
        "fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify(auth, null, 2) + '\\n');",
        "console.log('rotated');",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync(process.execPath, [generated.wrapperPath], { cwd: root });
    const store = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as { profiles?: Record<string, Record<string, unknown>> };
    const profile = store.profiles?.["openai-codex:user@example.com"];
    expect(profile?.access).toBe(rotatedAccess);
    expect(profile?.refresh).toBe("rotated-refresh-token");
    expect(profile?.expires).toBe(2_000_000_900_000);
    expect(profile?.idToken).toBe("rotated-id-token");
    expect(profile?.accountId).toBe(accountId);
  });

  it("launches the locally installed Claude ACP bin without going through npm", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const installedBinPath = path.join(root, "claude-agent-acp-bin.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null }));\n",
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => installedBinPath,
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [generated.wrapperPath, "--permission-mode", "bypass"],
      {
        cwd: root,
      },
    );
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexHome?: unknown };
    expect(launched.argv).toEqual(["--permission-mode", "bypass"]);
    expect(launched.codexHome).toBeNull();
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

  it("normalizes an explicitly configured Codex ACP command to the local wrapper", async () => {
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
    expect(resolved.agents.codex).not.toContain("npx @zed-industries/codex-acp@0.12.0");
    expect(resolved.agents.codex).toContain(quoteArg("-c"));
    expect(resolved.agents.codex).toContain(quoteArg('model="gpt-5.4"'));
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("process.argv.slice(2)");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);
  });

  it("normalizes an explicitly configured Claude ACP npx command to the local wrapper", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command: "npx -y @agentclientprotocol/claude-agent-acp@0.31.4 --permission-mode bypass",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => path.join(root, "claude-agent-acp.js"),
    });

    expectClaudeWrapperCommand(resolved.agents.claude, generated.wrapperPath);
    expect(resolved.agents.claude).not.toContain("npx -y @agentclientprotocol/claude-agent-acp");
    expect(resolved.agents.claude).toContain("--permission-mode");
    expect(resolved.agents.claude).toContain("bypass");
  });

  it("leaves a custom Claude agent command alone", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command: "node ./custom-claude-wrapper.mjs --flag",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => path.join(root, "claude-agent-acp.js"),
    });

    expect(resolved.agents.claude).toBe("node ./custom-claude-wrapper.mjs --flag");
  });

  it("does not normalize custom Claude commands that only mention the package name", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const command =
      "node ./custom-claude-wrapper.mjs @agentclientprotocol/claude-agent-acp@0.31.4 --flag";
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command,
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => path.join(root, "claude-agent-acp.js"),
    });

    expect(resolved.agents.claude).toBe(command);
  });
});
