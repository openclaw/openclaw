import fs from "node:fs/promises";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { isolatedParams } from "./isolated-completion.params-test-support.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import * as shared from "./shared-client.js";

const live =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_RESEARCH_ACCEPTANCE === "1";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setManagedCodexPluginRoot(undefined);
});

it.skipIf(!live)(
  "uses a real selected API route and joins native cancellation",
  { timeout: 300_000 },
  async () => {
    await withTempDir("openclaw-native-research-live-", async (root) => {
      setManagedCodexPluginRoot(path.resolve(import.meta.dirname, "../.."));
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const auth = await resolveApiKeyForProvider({ provider: "openai", cfg: {}, agentDir: root });
      if (auth.mode !== "api-key" || !auth.apiKey) {
        throw new Error("Selected OpenAI API-key route unavailable");
      }
      const modelId = process.env.OPENCLAW_LIVE_RESEARCH_MODEL || "gpt-6.1-sol";
      const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const selected = new URL(baseUrl);
      if (
        selected.protocol !== "https:" ||
        selected.username ||
        selected.password ||
        selected.search ||
        selected.hash
      ) {
        throw new Error("Unsupported selected endpoint");
      }
      const params = isolatedParams({ version: 1, profiles: {} }, "unused", root, root);
      params.modelId = modelId;
      params.timeoutMs = 120_000;
      params.streamParams = { maxTokens: 1_024 };
      params.thinkLevel = "off";
      params.authorization = {
        owner: "host",
        model: { provider: "openai", id: modelId, api: "openai-responses", baseUrl } as Model,
        auth,
      };
      params.systemPrompt = "Return only the requested structured result. Do not use tools.";
      params.prompt = "Set answer to exactly RESEARCH_NATIVE_OK.";
      params.outputSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      };
      let current = true;
      params.assertCurrent = () => {
        if (!current) {
          throw new Error("Research owner closed");
        }
      };
      const observations: Array<{
        home?: string;
        pid?: number;
        exited: boolean;
        version?: string;
      }> = [];
      const cancel = new AbortController();
      let cancelNextTurn = false;
      const create = shared.createIsolatedCodexAppServerClient;
      vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(async (options) => {
        const started = performance.now();
        const client = await create(options);
        const requests = vi.spyOn(client, "request");
        const notifications = new Map<string, number>();
        const observation = {
          home: options?.startOptions?.env?.CODEX_HOME,
          pid: client.getTransportPid(),
          exited: false,
          version: client.getServerVersion(),
        };
        observations.push(observation);
        client.addTransportExitHandler(() => {
          observation.exited = true;
          console.log(
            JSON.stringify({
              proof: "research-native-transport",
              elapsedMs: Math.round(performance.now() - started),
              nativeVersion: observation.version,
              requests: requests.mock.calls.map(([method]) => method),
              notifications: Object.fromEntries(notifications),
              closeError: client.getCloseError()?.name,
            }),
          );
        });
        client.addNotificationHandler((notification) => {
          notifications.set(notification.method, (notifications.get(notification.method) ?? 0) + 1);
          if (notification.method === "turn/started" && cancelNextTurn) {
            cancel.abort(new Error("Research acceptance cancellation"));
          }
        });
        return client;
      });
      const options = {
        pluginConfig: { appServer: { transport: "stdio" as const, homeScope: "agent" as const } },
      };
      const result = await runCodexIsolatedCompletion(params, options);
      expect(result.assistant.provider).toBe("openai");
      expect(result.assistant.model).toBe(modelId);
      expect(result.assistant.api).toBe("openai-responses");
      const text = result.assistant.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      expect(JSON.parse(text)).toEqual({ answer: "RESEARCH_NATIVE_OK" });
      cancelNextTurn = true;
      await expect(
        runCodexIsolatedCompletion({ ...params, abortSignal: cancel.signal }, options),
      ).rejects.toThrow();
      expect(cancel.signal.aborted).toBe(true);
      current = false;
      const count = observations.length;
      await expect(runCodexIsolatedCompletion(params, options)).rejects.toThrow(
        "Research owner closed",
      );
      expect(observations.length).toBe(count);
      for (const observation of observations) {
        expect(observation.exited).toBe(true);
        expect(observation.pid).toBeGreaterThan(0);
        expect(observation.home).toContain("codex-bounded-turn-");
        if (observation.home) {
          await expect(fs.access(observation.home)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      console.log(
        JSON.stringify({
          proof: "research-native",
          model: modelId,
          endpoint: selected.origin + selected.pathname,
          auth: "host-api-key",
          nativeVersion: observations[0]?.version,
          structured: true,
          cancelled: true,
          cleanup: "joined",
        }),
      );
    });
  },
);
