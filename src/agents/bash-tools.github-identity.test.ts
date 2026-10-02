import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";

const storeMocks = vi.hoisted(() => ({ readSecretStoreExecEnvironment: vi.fn() }));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/store/secret-store.js")>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
}));
const snapshot = captureEnv(["GH_TOKEN", "GITHUB_TOKEN", "PREVIEW_SERVICE_TOKEN"]);
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
    managedLocalIdentity: prepared.managedLocalIdentity,
    warnings: [],
  });
}

describe("exec GitHub identity", () => {
  it("keeps required sandbox execution isolated from host overrides, elevation, and GitHub credentials", async () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
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
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
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
