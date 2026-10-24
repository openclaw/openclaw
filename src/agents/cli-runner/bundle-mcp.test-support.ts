import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv, setTestEnvValue, withEnvAsync } from "../../test-utils/env.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "./bundle-mcp-codex.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

let envSnapshot: ReturnType<typeof captureEnv> | undefined;
const harness = {
  tempHarness: createBundleMcpTempHarness(),
  bundleProbeHomeDir: "",
  bundleProbeWorkspaceDir: "",
  bundleProbeServerPath: "",
};
export const cliBundleMcpHarness: Readonly<typeof harness> = harness;

export function requireMcpConfigPath(args: readonly string[] | undefined): string {
  const configFlagIndex = args?.indexOf("--mcp-config") ?? -1;
  assert(configFlagIndex >= 0, "expected --mcp-config arg");
  const generatedConfigPath = args?.[configFlagIndex + 1];
  assert(generatedConfigPath, "expected --mcp-config path arg");
  return generatedConfigPath;
}

export function setupCliBundleMcpTestHarness(): void {
  beforeEach(bindSessionMcpRuntimeTestScheduler);
  afterEach(disposeAllSessionMcpRuntimes);

  beforeAll(async () => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);
    const { tempHarness } = harness;
    const createDir = (kind: string) =>
      tempHarness.createTempDir(`openclaw-cli-bundle-mcp-${kind}-`);
    harness.bundleProbeHomeDir = await createDir("home");
    harness.bundleProbeWorkspaceDir = await createDir("workspace");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", await createDir("bundled"));
    ({ serverPath: harness.bundleProbeServerPath } = await createBundleProbePlugin(
      harness.bundleProbeHomeDir,
    ));
  });

  afterAll(async () => {
    envSnapshot?.restore();
    await cliBundleMcpHarness.tempHarness.cleanup();
  });
}

export async function writeCliMcpPolicyProbeServer(): Promise<string> {
  const filePath = `${cliBundleMcpHarness.bundleProbeWorkspaceDir}/policy-probe.mjs`;
  await fs.writeFile(
    filePath,
    `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policy-probe", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "read_docs", description: "read", inputSchema: { type: "object" } },
    { name: "delete_docs", description: "delete", inputSchema: { type: "object" } },
    { name: "task_docs", description: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
    { name: "app_docs", description: "app", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }
  ] });
});
`,
    "utf-8",
  );
  return filePath;
}

export function cliNativeMcpPolicyContext(
  config: OpenClawConfig,
  sessionId: string,
  workspaceDir = cliBundleMcpHarness.bundleProbeWorkspaceDir,
) {
  const session = { sessionId, sessionKey: `agent:main:${sessionId}` };
  return {
    ...session,
    capabilityProfile: resolveConversationCapabilityProfile({
      config,
      ...session,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.4-codex",
      workspaceDir,
    }),
  };
}

export async function prepareBundleProbeCliConfig(
  params?: Pick<Parameters<typeof prepareCliBundleMcpConfig>[0], "additionalConfig" | "env">,
) {
  const { bundleProbeHomeDir, bundleProbeWorkspaceDir } = cliBundleMcpHarness;
  return withEnvAsync({ HOME: bundleProbeHomeDir }, () =>
    prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "node", args: ["./fake-claude.mjs"] },
      workspaceDir: bundleProbeWorkspaceDir,
      config: { plugins: { entries: { "bundle-probe": { enabled: true } } } },
      ...params,
    }),
  );
}

export function prepareNativeMcpTestConfig(params: {
  workspaceDir: string;
  sessionId: string;
  config: OpenClawConfig;
  senderId?: string;
  sessionKey?: string;
  sandboxSessionKey?: string;
  sandboxAgentId?: string;
  timeoutMs?: number;
}) {
  const { workspaceDir, sessionId } = params;
  const authStorage = AuthStorage.inMemory();
  const sessionKey = params.sessionKey ?? `agent:main:${sessionId}`;
  return buildCodexUserMcpServersThreadConfigPatchForRun({
    cwd: workspaceDir,
    run: {
      ...params,
      agentId: "main",
      sessionKey,
      sessionFile: sessionKey,
      prompt: "hello",
      timeoutMs: params.timeoutMs ?? 5_000,
      runId: sessionId,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: makeProviderModelFixture({
        id: "gpt-5.6-luna",
        name: "Test model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "http://127.0.0.1:1",
        contextWindow: 100_000,
        maxTokens: 1_000,
      }),
      authStorage,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: ModelRegistry.inMemory(authStorage),
      thinkLevel: "off",
    },
  });
}
