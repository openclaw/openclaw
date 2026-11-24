import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";

const storeMocks = vi.hoisted(() => ({ readSecretStoreExecEnvironment: vi.fn() }));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/store/secret-store.js")>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
}));
const authorEnv = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;
const snapshot = captureEnv([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "PREVIEW_SERVICE_TOKEN",
  "GIT_CONFIG_PARAMETERS",
  ...authorEnv,
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
const execDefaults = { host: "gateway", security: "full", ask: "off" } as const;
const profileId = (digit: number) => `ghp_${String(digit).repeat(32)}`;
function appIdentity(digit: number, source: "env" | "store", id: string): GitHubToolIdentityConfig {
  return {
    kind: "app-installation",
    profileId: profileId(digit),
    app: {
      appId: 101,
      installationId: 202,
      accountId: 303,
      repositories: [{ id: 404, fullName: "example/project" }],
      permissions: { contents: "read" },
      keyVersion: "synthetic-v1",
      privateKey: { source, provider: "default", id },
    },
  };
}
const githubConfig = (github: GitHubToolIdentityConfig): OpenClawConfig => ({ tools: { github } });
afterEach(() => {
  snapshot.restore();
  vi.unstubAllEnvs();
  storeMocks.readSecretStoreExecEnvironment.mockReset();
});

function previewEnvironment(source: "env" | "store", id: string) {
  return prepareGitHubToolEnvironment({
    config: {},
    sourceConfig: {
      gateway: { controlUi: { github: { token: { source, provider: "default", id } } } },
    },
    agentId: "main",
  });
}

function prepare(
  host: "gateway" | "sandbox",
  prepared: ReturnType<typeof prepareGitHubToolEnvironment>,
  includeStoreSecrets = true,
) {
  return resolvePreparedExecEnvironment({
    execParams: { command: "gh api user" },
    host,
    sandbox:
      host === "sandbox"
        ? {
            containerName: "sandbox",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
          }
        : undefined,
    defaultPathPrepend: [],
    storeSecretEnv: includeStoreSecrets
      ? { GH_TOKEN: "store-sentinel", GITHUB_TOKEN: "store-sentinel" }
      : undefined,
    credentialScrubEnv: prepared.credentialScrubEnv,
    localIdentityEnv: prepared.localIdentityEnv,
    localGitConfigParameters: prepared.localGitConfigParameters,
    managedLocalIdentity: prepared.managedLocalIdentity,
    warnings: [],
  });
}

describe("exec GitHub identity", () => {
  it("keeps the executing agent's OAuth credentials and excludes all App keys when borrowing tool policy", async () => {
    const root = tempDirs.make("native-exec-credential-owner-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("FACTORY_APP_PEM", "synthetic-system-signing-key");
    vi.stubEnv("SIBLING_APP_PEM", "synthetic-sibling-signing-key");
    const config: OpenClawConfig = {
      tools: {
        exec: { host: "gateway", mode: "full" },
        github: appIdentity(3, "env", "FACTORY_APP_PEM"),
      },
      agents: {
        entries: {
          worker: {
            tools: { github: { kind: "oauth", profileId: profileId(1) } },
          },
          policy: { tools: { github: { profileId: profileId(2) } } },
          signer: { tools: { github: appIdentity(4, "store", "SIBLING_APP_PEM") } },
        },
      },
    };
    storeMocks.readSecretStoreExecEnvironment.mockResolvedValue({ env: {} });
    const prepared = prepareGitHubToolEnvironment({ config, agentId: "worker" });
    const profileDir = prepared.localIdentityEnv.GH_CONFIG_DIR!;
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-executing-agent\n",
      { mode: 0o600 },
    );
    const tools = createOpenClawCodingTools({
      agentId: "worker",
      policyAgentId: "policy",
      sessionKey: "agent:policy:main",
      runSessionKey: "agent:worker:main",
      config,
      workspaceDir: root,
      exec: { notifyOnExit: false, allowBackground: false },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    const tool = tools.find(({ name }) => name === "exec");
    expect(tool).toBeDefined();
    const script = path.join(root, "identity.cjs");
    await fs.writeFile(
      script,
      "process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, systemKey: process.env.FACTORY_APP_PEM, siblingKey: process.env.SIBLING_APP_PEM }))",
    );
    const result = await tool!.execute("native-owner", {
      command: [process.execPath, script].map((value) => JSON.stringify(value)).join(" "),
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: JSON.stringify({
        token: "synthetic-executing-agent",
        systemKey: "",
        siblingKey: "",
      }),
    });
    expect(storeMocks.readSecretStoreExecEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ excludeNames: ["SIBLING_APP_PEM"] }),
    );
  });

  it("fetches missing partial-clone blobs without launching automatic maintenance", async () => {
    // This fixture tests repository author inheritance, not the invoking session's override.
    for (const key of authorEnv) {
      deleteTestEnvValue(key);
    }
    const root = tempDirs.make("agent-git-maintenance-");
    const origin = path.join(root, "origin");
    const clone = path.join(root, "partial");
    const worktree = path.join(root, "worktree");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[], overlay: NodeJS.ProcessEnv = {}) =>
      execFileAsync("git", ["-C", cwd, ...args], { env: { ...env, ...overlay } });
    await git(root, ["init", "--initial-branch=main", origin]);
    await git(origin, ["config", "user.name", "Fixture Author"]);
    await git(origin, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(origin, "missing.txt"), "promised content\n");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "-m", "fixture"]);
    await git(origin, ["config", "uploadpack.allowFilter", "true"]);
    const blob = (await git(origin, ["rev-parse", "HEAD:missing.txt"])).stdout.trim();
    await git(root, [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(origin).href,
      clone,
    ]);
    await git(clone, ["config", "user.name", "Fixture Author"]);
    await git(clone, ["config", "user.email", "fixture@example.invalid"]);
    await git(clone, ["worktree", "add", "--no-checkout", "--detach", worktree]);
    const configPath = path.join(clone, ".git", "config");
    const configBefore = await fs.readFile(configPath, "utf8");
    const missing = await git(worktree, ["rev-list", "--objects", "--missing=print", "HEAD"]);
    expect(missing.stdout).toContain(`?${blob}`);
    setTestEnvValue(
      "GIT_CONFIG_PARAMETERS",
      "'user.name=Inherited Author' 'user.email=inherited@example.invalid' 'http.version=HTTP/1.1'",
    );

    for (const managed of [false, true]) {
      const prepared = prepareGitHubToolEnvironment({
        config: managed
          ? githubConfig({
              profileId: profileId(9),
              gitAuthor: { name: "Agent Author", email: "agent@example.invalid" },
            })
          : {},
        agentId: "main",
      });
      const tracePath = path.join(root, `trace-${managed}.jsonl`);
      const { env: childEnv, requestedEnv } = prepare("gateway", prepared, false);
      // Real Git consumes the composed exec environment, including inherited parameters.
      const overlay = { ...childEnv, ...env, GIT_TRACE2_EVENT: tracePath };
      await git(worktree, ["fetch", "origin", blob], overlay);
      expect((await git(worktree, ["cat-file", "blob", blob], overlay)).stdout).toBe(
        "promised content\n",
      );
      expect((await git(worktree, ["var", "GIT_AUTHOR_IDENT"], overlay)).stdout).toContain(
        managed
          ? "Agent Author <agent@example.invalid>"
          : "Inherited Author <inherited@example.invalid>",
      );
      expect(
        (await git(worktree, ["config", "--get", "http.version"], overlay)).stdout.trim(),
      ).toBe("HTTP/1.1");
      expect(requestedEnv?.GIT_CONFIG_PARAMETERS).toBeUndefined();
      const trace = (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const maintenance = trace.filter(
        (event) =>
          event.event === "child_start" &&
          event.argv?.includes("--auto") &&
          (event.argv.includes("maintenance") || event.argv.includes("gc")),
      );
      expect(maintenance).toEqual([]);
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
  });

  it("keeps required sandbox execution isolated from host overrides, elevation, and GitHub credentials", async () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    storeMocks.readSecretStoreExecEnvironment.mockResolvedValue({ env: {} });
    const buildExecSpec = vi.fn(async ({ env }: { env: Record<string, string> }) => ({
      argv: [process.execPath, "-e", "process.stdout.write('sandbox-ok')"],
      env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      ...execDefaults,
      allowBackground: false,
      sandboxRequired: true,
      sandbox: {
        containerName: "required-sandbox",
        workspaceDir: process.cwd(),
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
      preparedRunEnvironment: prepareGitHubToolEnvironment({
        config: githubConfig({ profileId: profileId(9) }),
        agentId: "main",
      }),
    });
    for (const host of ["gateway", "node"] as const) {
      await expect(
        tool.execute(`required-denied-${host}`, { command: "echo denied", host }),
      ).rejects.toThrow(/not allowed/i);
    }
    await expect(
      tool.execute("required-denied-elevation", { command: "echo denied", elevated: true }),
    ).rejects.toThrow(/requires a sandbox/i);
    const result = await tool.execute("required-sandbox", { command: "echo sandbox-ok" });
    expect(result.details.status).toBe("completed");
    expect(buildExecSpec).toHaveBeenCalledOnce();
    const sandboxEnv = buildExecSpec.mock.calls[0]![0].env;
    expect(sandboxEnv).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "" });
    expect(sandboxEnv).not.toHaveProperty("GH_CONFIG_DIR");
  });

  it("scrubs only an explicitly owned GH_TOKEN preview variable", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    const result = prepare("gateway", previewEnvironment("env", "GH_TOKEN"), false);
    expect(result.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "ambient-fallback" });
  });

  it("blanks a custom preview env ref for native local and sandbox exec", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("PREVIEW_SERVICE_TOKEN", "ambient-preview-token");
    const prepared = previewEnvironment("env", "PREVIEW_SERVICE_TOKEN");
    for (const host of ["gateway", "sandbox"] as const) {
      const result = prepare(host, prepared);
      expect(result.env).toMatchObject({
        PREVIEW_SERVICE_TOKEN: "",
        GH_TOKEN: "store-sentinel",
        GITHUB_TOKEN: "store-sentinel",
      });
      expect(result.requestedEnv?.PREVIEW_SERVICE_TOKEN).toBe("");
    }
  });

  it("excludes the preview store ref from native gateway exec projection", async () => {
    storeMocks.readSecretStoreExecEnvironment.mockResolvedValue({ env: {} });
    const preparedRunEnvironment = previewEnvironment("store", "PREVIEW_STORE_TOKEN");
    expect(preparedRunEnvironment.credentialScrubEnv.PREVIEW_STORE_TOKEN).toBe("");
    const tool = createExecTool({
      ...execDefaults,
      config: {},
      agentId: "main",
      preparedRunEnvironment,
    });
    await tool.execute("store-ref-native", { command: "echo ok" });
    expect(storeMocks.readSecretStoreExecEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ excludeNames: ["PREVIEW_STORE_TOKEN"] }),
    );
  });
});
