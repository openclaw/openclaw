import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createIsolatedCompletionBoundaryFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;

beforeEach(() => {
  root = dirs.make("isolated-adapter-proof-");
  for (const key of ["HOME", "CODEX_HOME", "OPENCLAW_STATE_DIR"]) {
    vi.stubEnv(key, root);
  }
});
afterEach(() => vi.unstubAllEnvs());

function unexpectedSessionBinding(): never {
  throw new Error("Isolated completion must not access session bindings");
}

it.each(["allowed", "forbidden", "revoked"] as const)(
  "preserves account authority through the real Codex adapter: %s",
  async (scenario) => {
    vi.stubEnv("OPENCLAW_QA_CODEX_APP_SERVER_VERSION", CODEX_APP_SERVER_VERSION);
    const log = path.join(root, "messages.jsonl");
    fs.writeFileSync(log, "");
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
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "openai:allowed": { provider: "openai", mode: "oauth" },
          "openai:forbidden": { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["openai:allowed"] },
      },
    };
    const credential = (identity: string) => ({
      type: "oauth" as const,
      provider: "openai",
      access: `synthetic-${identity}-access`,
      refresh: `synthetic-${identity}-refresh`,
      expires: 4102444800000,
      accountId: `synthetic-${identity}-account`,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:allowed": credential("allowed"),
        "openai:forbidden": credential("forbidden"),
      },
    };
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const harness = createCodexAppServerAgentHarness({
      bindingStore: {
        read: unexpectedSessionBinding,
        readMany: unexpectedSessionBinding,
        readNativeSubagentSubmissions: unexpectedSessionBinding,
        hasOtherThreadOwner: unexpectedSessionBinding,
        mutate: unexpectedSessionBinding,
        prepareSessionGenerationReclaim: unexpectedSessionBinding,
        adoptSessionGeneration: unexpectedSessionBinding,
        resetSessionGeneration: unexpectedSessionBinding,
        retireSessionGeneration: unexpectedSessionBinding,
        withSessionDeletion: unexpectedSessionBinding,
        withThreadArchiveFence: unexpectedSessionBinding,
        withLease: unexpectedSessionBinding,
      },
      pluginConfig: {
        appServer: {
          command: process.execPath,
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
      authStore: store,
      harness,
      async resolveModel(call) {
        // Hold the real materializePreparedRuntimeModel await after route/auth planning.
        if (scenario === "revoked" && call === 2) {
          enter();
          await gate;
        }
        return call === 1 ? platform : subscription;
      },
    });
    const pending = fixture.run({
      config,
      provider: "openai",
      model: "gpt-test",
      systemPrompt: "Return text.",
      prompt: "Do the task.",
      agentHarnessRuntimeOverride: "codex",
      agentDir: root,
      workspaceDir: root,
      timeoutMs: 20000,
      authProfileId: scenario === "forbidden" ? "openai:forbidden" : "openai:allowed",
      assertCurrent() {
        if (!current) {
          throw new Error("synthetic caller authority revoked during preparation");
        }
      },
    });
    let outcome: unknown;
    try {
      if (scenario === "revoked") {
        await awaitGateBeforeSettlement(entered, pending, "Completion skipped awaited preparation");
        delete store.profiles["openai:allowed"];
        current = false;
        release();
      }
      if (scenario === "allowed") {
        const result = await pending;
        expect(result.text).toBe("Completed as synthetic-allowed-account");
        outcome = { text: result.text, owner: result.owner };
      } else {
        const error: unknown = await pending.then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("Expected rejection");
        }
        expect(error.message).toMatch(
          scenario === "forbidden" ? /not configured/ : /authority revoked/,
        );
        outcome = { rejected: true, error: error.message };
      }
    } finally {
      release();
      await harness.dispose?.();
    }
    const messages: Array<{ method?: string; params?: unknown }> = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (scenario === "allowed") {
      const login = messages.find((message) => message.method === "account/login/start");
      expect(login?.params).toMatchObject({
        type: "chatgptAuthTokens",
        accessToken: "synthetic-allowed-access",
        chatgptAccountId: "synthetic-allowed-account",
      });
      expect(messages.filter((message) => message.method === "account/login/start")).toHaveLength(
        1,
      );
      expect(messages.findIndex((message) => message.method === "turn/start")).toBeGreaterThan(
        messages.findIndex((message) => message.method === "account/login/start"),
      );
    } else {
      expect(messages).toEqual([]);
    }
    const proofDir = process.env.OPENCLAW_TEST_ADAPTER_PROOF_DIR;
    if (proofDir) {
      const sanitized = JSON.parse(
        JSON.stringify(messages)
          .replaceAll(root, "<isolated-state>")
          .replaceAll("synthetic-allowed-access", "<synthetic-token:allowed>")
          .replaceAll("synthetic-forbidden-access", "<synthetic-token:forbidden>"),
      );
      fs.writeFileSync(
        path.join(proofDir, `${scenario}.json`),
        JSON.stringify({ scenario, outcome, messages: sanitized }, null, 2) + "\n",
      );
    }
  },
);
