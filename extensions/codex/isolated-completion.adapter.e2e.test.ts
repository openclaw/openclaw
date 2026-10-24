import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createIsolatedCompletionBoundaryFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveNodeRuntimeExecutable } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { testCodexAppServerBindingStore } from "./src/app-server/session-binding.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function unexpectedSessionBinding(): never {
  throw new Error("Isolated completion must not access session bindings");
}

it("preserves the selected account through the real Codex adapter", async () => {
  const root = dirs.make("isolated-adapter-proof-");
  for (const key of ["HOME", "CODEX_HOME", "OPENCLAW_STATE_DIR"]) {
    vi.stubEnv(key, root);
  }
  vi.stubEnv("OPENCLAW_QA_CODEX_APP_SERVER_VERSION", CODEX_APP_SERVER_VERSION);
  const log = path.join(root, "messages.jsonl");
  vi.stubEnv("OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG", log);
  const platform: Model<"openai-responses"> = {
    provider: "openai",
    id: "gpt-test",
    name: "Test",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
  };
  const subscription: Model<"openai-chatgpt-responses"> = {
    ...platform,
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  };
  const config = {};
  const node = resolveNodeRuntimeExecutable();
  assert(node, "The Codex adapter fixture requires a Node runtime");
  const harness = createCodexAppServerAgentHarness({
    bindingStore: new Proxy(testCodexAppServerBindingStore, { get: unexpectedSessionBinding }),
    pluginConfig: {
      appServer: {
        command: node,
        args: [
          path.join(repo, "test/e2e/qa-lab/runtime/codex-isolated-app-server.fixture.mjs"),
          "app-server",
        ],
        transport: "stdio",
        homeScope: "agent",
      },
    },
  });
  const fixture = await createIsolatedCompletionBoundaryFixture({
    config,
    root,
    catalog: { entries: [platform], routeVariants: [platform, subscription] },
    authStore: {
      version: 1,
      profiles: {
        "openai:allowed": {
          type: "oauth",
          provider: "openai",
          access: "synthetic-allowed-access",
          refresh: "synthetic-allowed-refresh",
          expires: 4102444800000,
          accountId: "synthetic-allowed-account",
        },
      },
    },
    harness,
    async resolveModel(call) {
      return call === 1 ? platform : subscription;
    },
  });
  try {
    const result = await fixture.run({
      config,
      provider: "openai",
      model: "gpt-test",
      systemPrompt: "Return text.",
      prompt: "Do the task.",
      agentHarnessRuntimeOverride: "codex",
      agentDir: root,
      workspaceDir: root,
      timeoutMs: 20000,
      authProfileId: "openai:allowed",
    });
    expect(result.text).toBe("Completed as synthetic-allowed-account");
  } finally {
    await harness.dispose?.();
  }
  const messages: Array<{ method?: string; params?: unknown }> = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const logins = messages.filter((message) => message.method === "account/login/start");
  expect(logins).toHaveLength(1);
  expect(logins[0]?.params).toMatchObject({
    type: "chatgptAuthTokens",
    accessToken: "synthetic-allowed-access",
    chatgptAccountId: "synthetic-allowed-account",
  });
  expect(messages.findIndex((message) => message.method === "turn/start")).toBeGreaterThan(
    messages.findIndex((message) => message.method === "account/login/start"),
  );
});
