import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { INVALID_GITHUB_SELECTION_EXEC_TOKEN } from "./github-invalid-selection.js";
import {
  prepareGitHubToolEnvironment,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const storeMocks = vi.hoisted(() => ({ readSecretStoreExecEnvironment: vi.fn() }));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/store/secret-store.js")>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
}));
const OTHER_ACCOUNT_TOKEN = "fixture-other-github-account";
const snapshot = captureEnv([
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GIT_CONFIG_PARAMETERS",
  "PREVIEW_SERVICE_TOKEN",
  "XDG_CONFIG_HOME",
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
afterEach(() => {
  snapshot.restore();
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
    ...(host === "sandbox"
      ? {
          sandbox: {
            containerName: "sandbox",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
          },
        }
      : {}),
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
  it("fetches missing partial-clone blobs without launching automatic maintenance", async () => {
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
          ? {
              tools: {
                github: {
                  profileId: "ghp_99999999999999999999999999999999",
                  gitAuthor: { name: "Agent Author", email: "agent@example.invalid" },
                },
              },
            }
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
      host: "gateway",
      security: "full",
      ask: "off",
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
        config: { tools: { github: { profileId: "ghp_99999999999999999999999999999999" } } },
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
    expect(sandboxEnv.GH_TOKEN).toBe("");
    expect(sandboxEnv.GITHUB_TOKEN).toBe("");
    expect(sandboxEnv).not.toHaveProperty("GH_CONFIG_DIR");
  });

  it("scrubs only an explicitly owned GH_TOKEN preview variable", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    const result = prepare("gateway", previewEnvironment("env", "GH_TOKEN"), false);
    expect(result.env.GH_TOKEN).toBe("");
    expect(result.env.GITHUB_TOKEN).toBe("ambient-fallback");
  });

  it("blanks a custom preview env ref for native local and sandbox exec", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("PREVIEW_SERVICE_TOKEN", "ambient-preview-token");
    const prepared = previewEnvironment("env", "PREVIEW_SERVICE_TOKEN");
    for (const host of ["gateway", "sandbox"] as const) {
      const result = prepare(host, prepared);
      expect(result.env.PREVIEW_SERVICE_TOKEN).toBe("");
      expect(result.requestedEnv?.PREVIEW_SERVICE_TOKEN).toBe("");
      expect(result.env.GH_TOKEN).toBe("store-sentinel");
      expect(result.env.GITHUB_TOKEN).toBe("store-sentinel");
    }
  });

  it("excludes the preview store ref from native gateway exec projection", async () => {
    storeMocks.readSecretStoreExecEnvironment.mockResolvedValue({ env: {} });
    const preparedRunEnvironment = previewEnvironment("store", "PREVIEW_STORE_TOKEN");
    expect(preparedRunEnvironment.credentialScrubEnv.PREVIEW_STORE_TOKEN).toBe("");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      config: {},
      agentId: "main",
      preparedRunEnvironment,
    });
    await tool.execute("store-ref-native", { command: "echo ok" });
    expect(storeMocks.readSecretStoreExecEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ excludeNames: ["PREVIEW_STORE_TOKEN"] }),
    );
  });

  it("does not fail-close gateway echo when a legacy PAT-shaped GitHub profile is configured", async () => {
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-github-legacy-pat-")),
    );
    try {
      const config = {
        tools: {
          github: {
            profileId: `ghp_${"Z".repeat(36)}`,
            kind: "oauth" as const,
          },
        },
      };
      const preparedRunEnvironment = prepareGitHubToolEnvironment({
        config,
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: profileRoot },
      });
      expect(preparedRunEnvironment.invalidGitHubSelection).toBe(true);
      expect(preparedRunEnvironment.managedLocalIdentity).toBe(true);
      expect(preparedRunEnvironment.localIdentityEnv.GH_CONFIG_DIR).toEqual(expect.any(String));
      await expect(
        fs.access(preparedRunEnvironment.localIdentityEnv.GH_CONFIG_DIR ?? ""),
      ).rejects.toThrow();
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        config,
        agentId: "main",
        preparedRunEnvironment,
      });

      const result = await tool.execute("legacy-pat-echo", { command: "echo hello-legacy" });

      expect(result.details.status).toBe("completed");
      if (result.details.status !== "completed") {
        throw new Error("expected completed exec result");
      }
      expect(result.details.exitCode).toBe(0);
      expect(result.details.aggregated).toContain("hello-legacy");
      expect(result.details.aggregated).not.toContain(
        "GitHub Identity credential is unavailable or insecure",
      );
    } finally {
      await fs.rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("does not use a shared profile or native token for an invalid agent selection", async () => {
    setTestEnvValue("GH_TOKEN", "native-should-not-be-used");
    setTestEnvValue("GITHUB_TOKEN", "native-fallback-should-not-be-used");
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-github-invalid-agent-")),
    );
    try {
      const systemProfileId = "ghp_11111111111111111111111111111111";
      const config = {
        tools: { github: { profileId: systemProfileId, kind: "oauth" as const } },
        agents: {
          entries: {
            main: {
              tools: {
                github: { profileId: `ghp_${"Z".repeat(36)}`, kind: "oauth" as const },
              },
            },
          },
        },
      };
      const prepared = prepareGitHubToolEnvironment({
        config,
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: profileRoot },
      });
      const resolved = resolvePreparedExecEnvironment({
        execParams: { command: "echo hello-legacy" },
        host: "gateway",
        defaultPathPrepend: [],
        ...prepared,
        warnings: [],
      });
      expect(resolved.env.GH_CONFIG_DIR).toBe(prepared.localIdentityEnv.GH_CONFIG_DIR);
      expect(resolved.env.GH_CONFIG_DIR).not.toContain(systemProfileId);
      await expect(fs.access(resolved.env.GH_CONFIG_DIR ?? "")).rejects.toThrow();
      expect(resolved.env.GH_TOKEN).toBe(INVALID_GITHUB_SELECTION_EXEC_TOKEN);
      expect(resolved.env.GITHUB_TOKEN).toBe(INVALID_GITHUB_SELECTION_EXEC_TOKEN);
      expect(JSON.stringify(resolved.env)).not.toContain(systemProfileId);
      expect(JSON.stringify(resolved.env)).not.toContain("native-should-not-be-used");
      expect(JSON.stringify(resolved.env)).not.toContain("native-fallback-should-not-be-used");

      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        config,
        agentId: "main",
        preparedRunEnvironment: prepared,
      });
      const echo = await tool.execute("invalid-agent-echo", { command: "echo hello-legacy" });
      expect(echo.details.status).toBe("completed");
      if (echo.details.status !== "completed") {
        throw new Error("expected completed exec result");
      }
      expect(echo.details.exitCode).toBe(0);
      expect(echo.details.aggregated).toContain("hello-legacy");

      const gh = await tool.execute("invalid-agent-gh", { command: "gh api user" });
      expect(gh.details.status).toBe("completed");
      if (gh.details.status !== "completed") {
        throw new Error("expected completed exec result");
      }
      expect(gh.details.exitCode).toBe(1);
      expect(gh.details.aggregated).toContain(
        "GitHub Identity credential is unavailable or insecure",
      );
      expect(gh.details.aggregated).not.toContain("native-should-not-be-used");
      expect(gh.details.aggregated).not.toContain(systemProfileId);
    } finally {
      await fs.rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("does not turn an invalid shared profile into native GitHub exec", async () => {
    setTestEnvValue("GH_TOKEN", "native-should-not-be-used");
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-github-invalid-shared-")),
    );
    try {
      const config = {
        tools: { github: { profileId: `ghp_${"A".repeat(36)}`, kind: "oauth" as const } },
      };
      const prepared = prepareGitHubToolEnvironment({
        config,
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: profileRoot },
      });
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        config,
        agentId: "main",
        preparedRunEnvironment: prepared,
      });
      const gh = await tool.execute("invalid-shared-gh", { command: "gh api user" });
      expect(gh.details.status).toBe("completed");
      if (gh.details.status !== "completed") {
        throw new Error("expected completed exec result");
      }
      expect(gh.details.exitCode).toBe(1);
      expect(gh.details.aggregated).toContain("Reconnect or change GitHub Identity, then retry.");
      expect(gh.details.aggregated).not.toContain("native-should-not-be-used");
    } finally {
      await fs.rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("still fail-closes gateway exec when a managed GitHub identity is missing", async () => {
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-github-missing-identity-")),
    );
    try {
      const config = {
        tools: { github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      };
      const preparedRunEnvironment = prepareGitHubToolEnvironment({
        config,
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: profileRoot },
      });
      expect(preparedRunEnvironment.managedLocalIdentity).toBe(true);
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        config,
        agentId: "main",
        preparedRunEnvironment,
      });

      const result = await tool.execute("missing-identity-echo", { command: "echo hello-missing" });

      expect(result.details.status).toBe("completed");
      if (result.details.status !== "completed") {
        throw new Error("expected completed exec result");
      }
      expect(result.details.exitCode).toBe(1);
      expect(result.details.aggregated).toContain(
        "GitHub Identity credential is unavailable or insecure",
      );
      expect(result.details.aggregated).not.toContain("hello-missing");
    } finally {
      await fs.rm(profileRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps indirect gh and scripts off another available account",
    async () => {
      storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
      const root = await fs.realpath(tempDirs.make("exec-github-invalid-client-"));
      const bin = path.join(root, "bin");
      const otherConfig = path.join(root, "other-gh");
      const xdg = path.join(root, "xdg");
      const sharedProfileId = "ghp_11111111111111111111111111111111";
      const legacyProfileId = `ghp_${"Z".repeat(36)}`;
      const stateDir = path.join(root, "state");
      await fs.mkdir(bin, { recursive: true });
      await writeOtherAccount(otherConfig);
      await writeOtherAccount(path.join(xdg, "gh"));
      const sharedDir = resolveManagedGitHubProfileDir({
        agentId: "main",
        scope: "system",
        profileId: sharedProfileId,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      await writeOtherAccount(sharedDir);
      const stubPath = path.join(root, "gh-stub.mjs");
      await fs.writeFile(stubPath, GH_CLIENT_STUB_SOURCE);
      const node = JSON.stringify(process.execPath);
      const stub = JSON.stringify(stubPath);
      await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\nexec ${node} ${stub} "$@"\n`, {
        mode: 0o755,
      });
      const scriptPath = path.join(root, "call-gh.sh");
      await fs.writeFile(scriptPath, "#!/bin/sh\ngh api user\n", { mode: 0o755 });

      setTestEnvValue("GH_TOKEN", OTHER_ACCOUNT_TOKEN);
      setTestEnvValue("GITHUB_TOKEN", OTHER_ACCOUNT_TOKEN);
      setTestEnvValue("GH_ENTERPRISE_TOKEN", OTHER_ACCOUNT_TOKEN);
      setTestEnvValue("GITHUB_ENTERPRISE_TOKEN", OTHER_ACCOUNT_TOKEN);
      setTestEnvValue("GH_CONFIG_DIR", otherConfig);
      setTestEnvValue("XDG_CONFIG_HOME", xdg);

      const config = {
        tools: { github: { profileId: sharedProfileId, kind: "oauth" as const } },
        agents: {
          entries: {
            main: {
              tools: { github: { profileId: legacyProfileId, kind: "oauth" as const } },
            },
          },
        },
      };
      const prepared = prepareGitHubToolEnvironment({
        config,
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      expect(prepared.invalidGitHubSelection).toBe(true);
      expect(prepared.localIdentityEnv.GH_CONFIG_DIR).not.toBe(sharedDir);
      expect(prepared.localIdentityEnv.GH_CONFIG_DIR).not.toBe(otherConfig);
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        pathPrepend: [bin],
        config,
        agentId: "main",
        preparedRunEnvironment: prepared,
      });

      const echo = await tool.execute("legacy-echo", { command: "echo hello-legacy" });
      expect(echo.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(echo.details.status === "completed" ? echo.details.aggregated : "").toContain(
        "hello-legacy",
      );

      const direct = await tool.execute("legacy-direct-gh", { command: "gh api user" });
      expect(direct.details).toMatchObject({ status: "completed", exitCode: 1 });
      const directOutput = direct.details.status === "completed" ? direct.details.aggregated : "";
      expect(directOutput).toContain("GitHub Identity credential is unavailable or insecure");
      expect(directOutput).not.toContain(OTHER_ACCOUNT_TOKEN);
      expect(directOutput).not.toContain("AUTH=other-account");

      for (const [id, command] of [
        ["legacy-indirect-gh", "sh -c 'gh api user'"],
        ["legacy-script-gh", `sh ${JSON.stringify(scriptPath)}`],
      ] as const) {
        const result = await tool.execute(id, { command });
        expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
        const output = result.details.status === "completed" ? result.details.aggregated : "";
        expect(output).toContain("AUTH=sentinel");
        expect(output).toContain("FALLTHROUGH=none");
        expect(output).not.toContain(OTHER_ACCOUNT_TOKEN);
        expect(output).not.toContain("AUTH=other-account");
        expect(output).not.toContain(sharedDir);
        expect(output).not.toContain(otherConfig);
      }
    },
  );
});

const GH_CLIENT_STUB_SOURCE = `
import fs from "node:fs";
import path from "node:path";

const other = ${JSON.stringify(OTHER_ACCOUNT_TOKEN)};
const sentinel = ${JSON.stringify(INVALID_GITHUB_SELECTION_EXEC_TOKEN)};
const tokenNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const selected = tokenNames.find((name) => process.env[name]);
const configured = process.env.GH_CONFIG_DIR;
const configDir = configured
  ? configured
  : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"), "gh");
let hosts = "";
try {
  hosts = fs.readFileSync(path.join(configDir, "hosts.yml"), "utf8");
} catch {
  hosts = "";
}
const fallthrough = hosts.includes(other)
  ? "other-account"
  : hosts.includes("oauth_token:")
    ? "configured"
    : "none";
if (selected) {
  const value = process.env[selected];
  if (value === sentinel) {
    process.stdout.write("AUTH=sentinel\\nFALLTHROUGH=" + fallthrough + "\\n");
    process.exit(1);
  }
  if (value === other) {
    process.stdout.write("AUTH=other-account\\nFALLTHROUGH=" + fallthrough + "\\n");
    process.exit(0);
  }
  process.stdout.write("AUTH=unexpected-env\\nFALLTHROUGH=" + fallthrough + "\\n");
  process.exit(0);
}
const auth = fallthrough === "other-account" ? "other-account" : "none";
process.stdout.write("AUTH=" + auth + "\\nFALLTHROUGH=" + fallthrough + "\\n");
process.exit(fallthrough === "none" ? 1 : 0);
`;

async function writeOtherAccount(dir: string) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dir, "hosts.yml"),
    `github.com:\n  user: other-account\n  oauth_token: ${OTHER_ACCOUNT_TOKEN}\n`,
    { mode: 0o600 },
  );
}
