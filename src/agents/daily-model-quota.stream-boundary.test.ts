import type { StreamFunction } from "@openclaw/llm-core";
import { expect, it, vi } from "vitest";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { createLlmRuntime } from "../../packages/ai/src/stream.js";
import {
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  notifyProviderHttpMetadata,
  withProviderAcceptanceObserver,
} from "../../packages/ai/src/transports/transport-stream-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAssistantFailoverSignal } from "./embedded-agent-helpers/assistant-message-failures.js";
import { createRetryController } from "./embedded-agent-runner/run/failover-retry-controller.test-support.js";
import { coerceToFailoverError } from "./failover-error.js";
import { classifyFailoverSignal } from "./failover/classify.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const sleeps = vi.hoisted(() => ({ wait: vi.fn(async () => {}) }));
vi.mock("../infra/backoff.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/backoff.js")>("../infra/backoff.js")),
  sleepWithAbort: sleeps.wait,
}));

// Fixed external failures traverse registered dispatch, real terminal projection,
// retry admission and fallback ownership; this does not boot an embedded session.
it.each([
  { name: "daily quota uses configured backup", daily: true, disabled: false },
  { name: "daily quota honors explicit empty fallback list", daily: true, disabled: true },
  { name: "ordinary throttle retains same-model retry", daily: false, disabled: false },
])("$name", async ({ daily, disabled }) => {
  sleeps.wait.mockClear();
  const requests: string[] = [];
  const acceptance = vi.fn();
  const response = vi.fn();
  const terminals: Array<{ quotaScope?: string; stopReason: string }> = [];
  const runtime = createLlmRuntime();
  const transport: StreamFunction = (model, _context, options) => {
    requests.push(model.id);
    const { stream } = createWritableTransportEventStream();
    const output = {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: createEmptyTransportUsage(),
      timestamp: 0,
      stopReason: "stop" as const,
    };
    void (async () => {
      const rejected = model.id === "selected" && (daily || requests.length === 1);
      await notifyProviderHttpMetadata({
        options,
        response: { status: rejected ? 429 : 200, headers: {} },
        model,
        cancelStream: () => {},
      });
      if (rejected) {
        failTransportStream({
          stream,
          output,
          error: Object.assign(new Error("429 request rejected"), {
            status: 429,
            code: "RESOURCE_EXHAUSTED",
            ...(daily ? { quotaScope: "daily-model" } : {}),
          }),
        });
      } else {
        finalizeTransportStream({ stream, output });
      }
    })();
    return stream;
  };
  runtime.registry.registerApiProvider({
    api: "provider-cedar",
    stream: transport,
    streamSimple: transport,
  });
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: { primary: "ProviderCedar/selected", fallbacks: ["ProviderCedar/backup"] },
      },
    },
  };
  const result = runWithModelFallback({
    cfg,
    provider: "ProviderCedar",
    model: "selected",
    skipAuthProfileRuntime: true,
    manifestPlugins: [],
    ...(disabled ? { fallbacksOverride: [] } : {}),
    run: async (provider, modelId) => {
      const retry = createRetryController({ runtime: { provider, modelId } });
      for (;;) {
        const stream = runtime.streamSimple(
          makeProviderModel("provider-cedar", provider, modelId),
          { messages: [] },
          withProviderAcceptanceObserver({ onResponse: response }, acceptance),
        );
        const events = [];
        for await (const event of stream) {
          events.push(event.type);
        }
        const message = await stream.result();
        terminals.push(message);
        expect(events).toEqual([message.stopReason === "error" ? "error" : "done"]);
        if (message.stopReason !== "error") {
          return message.model;
        }
        expect(message.quotaScope).toBe(daily ? "daily-model" : undefined);
        const signal = buildAssistantFailoverSignal(message);
        const classification = classifyFailoverSignal(signal);
        expect(classification).toEqual({
          kind: "reason",
          reason: "rate_limit",
          ...(daily ? { sameModelRetry: false } : {}),
        });
        if (classification?.kind !== "reason" || classification.reason !== "rate_limit") {
          throw new Error("Missing retry classification");
        }
        if (
          await retry.maybeRetryTransient({
            reason: classification.reason,
            sameModelRetry: classification.sameModelRetry,
          })
        ) {
          continue;
        }
        throw (
          coerceToFailoverError(signal, { provider, model: modelId }) ??
          new Error("Missing normalized provider failure")
        );
      }
    },
  });
  if (disabled) {
    await expect(result).rejects.toMatchObject({ reason: "rate_limit", quotaScope: "daily-model" });
    expect(requests).toEqual(["selected"]);
    expect(acceptance).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toMatchObject({ result: daily ? "backup" : "selected" });
    expect(requests).toEqual(daily ? ["selected", "backup"] : ["selected", "selected"]);
    expect(acceptance).toHaveBeenCalledExactlyOnceWith({
      kind: "http_response",
      status: 200,
      headers: {},
    });
  }
  expect(response.mock.calls.map(([metadata]) => metadata.status)).toEqual(
    disabled ? [429] : [429, 200],
  );
  expect(sleeps.wait).toHaveBeenCalledTimes(daily ? 0 : 1);
  expect(terminals.map((message) => message.stopReason)).toEqual(
    disabled ? ["error"] : ["error", "stop"],
  );
});
