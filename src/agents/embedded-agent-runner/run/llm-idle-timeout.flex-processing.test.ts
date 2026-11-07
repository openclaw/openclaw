import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "../../runtime/index.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

type TimeoutParams = NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>;
const cloud = { provider: "openai", baseUrl: "https://api.openai.com/v1" };

afterEach(() => vi.useRealTimers());

describe("Flex request watchdogs", () => {
  it.each<[string, TimeoutParams, number]>([
    ["implicit budget", {}, 600_000],
    ["shorter run", { runTimeoutMs: 30_000 }, 30_000],
    ["shorter provider", { modelRequestTimeoutMs: 45_000 }, 45_000],
    ["longer provider", { modelRequestTimeoutMs: 1_200_000 }, 600_000],
    ["shorter agent", { cfg: { agents: { defaults: { timeoutSeconds: 20 } } } }, 20_000],
    ["unlimited run", { runTimeoutMs: MAX_TIMER_TIMEOUT_MS }, 600_000],
    ["cloud cron", { trigger: "cron", runTimeoutMs: 1_200_000 }, 60_000],
    ["cloud cron without explicit run budget", { trigger: "cron" }, 60_000],
    [
      "cloud cron with longer provider",
      { trigger: "cron", modelRequestTimeoutMs: 900_000 },
      60_000,
    ],
    [
      "cloud cron with shorter provider",
      { trigger: "cron", modelRequestTimeoutMs: 15_000 },
      15_000,
    ],
  ])("honors %s for both first response and idle", (_name, params, expected) => {
    const input = { ...params, model: cloud, flexProcessing: true };
    expect(resolveLlmIdleTimeoutMs(input)).toBe(expected);
    expect(resolveLlmFirstEventTimeoutMs(input)).toBe(expected);
  });

  it("preserves ordinary cloud watchdogs without the Flex opt-in", () => {
    expect(resolveLlmIdleTimeoutMs({ model: cloud })).toBe(120_000);
    expect(resolveLlmFirstEventTimeoutMs({ model: cloud })).toBe(120_000);
    expect(resolveLlmIdleTimeoutMs({ model: cloud, modelRequestTimeoutMs: 900_000 })).toBe(900_000);
    expect(resolveLlmFirstEventTimeoutMs({ model: cloud, modelRequestTimeoutMs: 900_000 })).toBe(
      900_000,
    );
  });

  it("keeps a queued request alive past the cloud default and aborts it at the Flex ceiling", async () => {
    vi.useFakeTimers();
    const params = { model: cloud, flexProcessing: true };
    const onTimeout = vi.fn();
    let providerSignal: AbortSignal | undefined;
    const provider: StreamFn = (_model, _context, options) =>
      new Promise<Awaited<ReturnType<StreamFn>>>((_resolve, reject) => {
        providerSignal = options?.signal;
        providerSignal?.addEventListener(
          "abort",
          () => reject(toErrorObject(providerSignal?.reason, "Provider request aborted")),
          { once: true },
        );
      });
    const pending = streamWithIdleTimeout(
      provider,
      resolveLlmIdleTimeoutMs(params),
      onTimeout,
    )({} as Parameters<StreamFn>[0], {} as Parameters<StreamFn>[1]);
    const rejected = expect(pending).rejects.toMatchObject({ name: "LlmIdleTimeoutError" });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(providerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
