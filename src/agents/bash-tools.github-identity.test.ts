import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";

const storeMocks = vi.hoisted(() => ({ readSecretStoreExecEnvironment: vi.fn() }));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/store/secret-store.js")>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
}));
const snapshot = captureEnv([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "PREVIEW_SERVICE_TOKEN",
  "GIT_CONFIG_PARAMETERS",
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
});
