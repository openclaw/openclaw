import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as backoff from "../infra/backoff.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { StreamFn } from "./runtime/index.js";
import { completionModelDefinition } from "./simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "./test-helpers/assistant-event-stream.test-support.js";

it("shares model saturation across embedded sessions and preserves recovery without fallbacks", async () => {
  await withOpenClawTestState({ label: "shared-rate-limit" }, async (state) => {
    const pluginId = "scripted-openai";
    const bundled = state.path("bundled");
    const rootDir = path.join(bundled, pluginId);
    await fs.mkdir(rootDir, { recursive: true });
    const fixture = createColdPluginFixture({
      rootDir,
      pluginId,
      providerId: "openai",
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        providers: ["openai"],
      },
    });
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => offset);
    const sleeps = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (delay) => {
      offset += delay;
    });
    const requests: string[] = [];
    const gateWaits: string[] = [];
    let primaryFailures = Infinity;
    const stream: StreamFn = (model) => {
      requests.push(model.id);
      const failed = model.id === "mock-primary" && primaryFailures-- > 0;
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: failed ? [] : [{ type: "text", text: `ANSWER:${model.id}` }],
        stopReason: failed ? "error" : "stop",
        ...(failed
          ? {
              errorMessage:
                "429 Rate limit reached for mock-primary in organization org-fixture on tokens per min (TPM): Limit 10000, Used 9900, Requested 200. Please try again in 48ms.",
              retryAfterMs: 48,
            }
          : {}),
      });
      return createQueuedAssistantStream((push) => {
        if (failed) {
          push({ type: "error", reason: "error", error: message });
        } else {
          push({ type: "done", reason: "stop", message });
        }
      });
    };
    const bridgeKey = `__shared_rate_limit_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { stream } });
    await fs.writeFile(
      fixture.runtimeSource,
      // A provider factory stays inside the real stream admission gate.
      `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
        const bridge = globalThis[${JSON.stringify(bridgeKey)}];
        api.registerProvider({ id: "openai", label: "Scripted OpenAI", auth: [],
          createStreamFn: () => (model, context, options) => bridge.stream(model, context, options) });
      } };`,
    );
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "openai/mock-primary", fallbacks: ["openai/mock-fallback"] },
        },
      },
      models: {
        mode: "replace",
        providers: {
          openai: {
            api: "openai-responses",
            auth: "api-key",
            apiKey: "synthetic-rate-limit-key",
            baseUrl: "https://rate-limit.example/v1",
            models: ["mock-primary", "mock-fallback"].map((id) =>
              completionModelDefinition({ id, contextWindow: 200_000 }),
            ),
          },
        },
      },
      plugins: {
        allow: [pluginId],
        slots: { memory: "none" },
        entries: { [pluginId]: { enabled: true } },
      },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(config);
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Scripted rate-limit fixture must not perform network I/O");
    });
    const sessionIds: string[] = [];
    try {
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          setRuntimeConfigSnapshot(config);
          const run = async (sessionId: string, fallbacksOverride?: string[]) => {
            sessionIds.push(sessionId);
            const admission = prepareSystemAgentRunAdmission(
              config,
              sessionId,
              "main",
              "scripted-rate-limit",
            );
            try {
              return await runWithModelFallback({
                cfg: config,
                agentDir: state.agentDir(),
                provider: "openai",
                model: "mock-primary",
                sessionId,
                fallbacksOverride,
                run: (provider, model, options) =>
                  runEmbeddedAgent({
                    preparedRunAdmission: admission,
                    config,
                    runId: sessionId,
                    sessionId,
                    agentDir: state.agentDir(),
                    workspaceDir: state.workspaceDir,
                    sessionTarget: {
                      agentId: "main",
                      sessionId,
                      sessionKey: `agent:main:${sessionId}`,
                      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
                    },
                    provider,
                    model,
                    modelFallbacksOverride: fallbacksOverride,
                    isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
                    allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
                    prompt: "Reply with the model name.",
                    disableTools: true,
                    cleanupBundleMcpOnRunEnd: true,
                    timeoutMs: 30_000,
                    onAgentEvent: (event) => {
                      if (
                        event.stream === "run_status" &&
                        typeof event.data.message === "string" &&
                        event.data.message.startsWith("Waiting for rate limit.")
                      ) {
                        gateWaits.push(event.data.message);
                      }
                    },
                  }),
              });
            } finally {
              admission.close();
            }
          };
          const first = await run("rate-limit-a");
          expect(first.model).toBe("mock-fallback");
          expect(first.result.payloads?.[0]?.text).toBe("ANSWER:mock-fallback");
          expect(requests).toEqual([
            "mock-primary",
            "mock-primary",
            "mock-primary",
            "mock-fallback",
          ]);
          expect(sleeps).toHaveBeenCalledTimes(2);
          requests.length = 0;
          const second = await run("rate-limit-b");
          expect(second.model).toBe("mock-fallback");
          expect(second.attempts).toMatchObject([{ model: "mock-primary", reason: "rate_limit" }]);
          expect(requests).toEqual(["mock-fallback"]);
          offset += 61_000;
          primaryFailures = 0;
          requests.length = 0;
          expect((await run("rate-limit-c")).model).toBe("mock-primary");
          expect(requests).toEqual(["mock-primary"]);
          primaryFailures = 3;
          requests.length = 0;
          sleeps.mockClear();
          gateWaits.length = 0;
          expect((await run("rate-limit-strict", [])).model).toBe("mock-primary");
          expect(requests).toEqual(Array(4).fill("mock-primary"));
          expect(sleeps).toHaveBeenCalledTimes(3);
          expect(gateWaits.length).toBeGreaterThan(0);
          expect(network).not.toHaveBeenCalled();
        },
      );
    } finally {
      network.mockRestore();
      sleeps.mockRestore();
      clock.mockRestore();
      monotonic.mockRestore();
      await resetPreparedModelRuntimeSnapshotsForTest();
      resetPluginLoaderTestStateForTest();
      cleanupPluginLoaderFixturesForTest();
      clearPluginMetadataLifecycleCaches();
      clearEmbeddedSessionPromptStates(sessionIds);
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  });
});
