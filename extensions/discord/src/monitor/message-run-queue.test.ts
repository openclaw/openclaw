import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
// Discord tests cover durable ingress settlement for queued message runs.
import { describe, expect, it, vi } from "vitest";
import type { DiscordInboundJob } from "./inbound-job.js";
import { createDiscordMessageRunQueue } from "./message-run-queue.js";

function createRuntime(): RuntimeEnv {
  return { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
}

function createJob(params?: {
  settle?: () => Promise<void>;
  abandon?: (error?: unknown) => Promise<void>;
  cancel?: () => Promise<void>;
}): DiscordInboundJob {
  return {
    queueKey: "agent:main:discord:channel:thread-1",
    payload: {
      message: { id: "message-1" },
    },
    runtime: {},
    ingressSettlement: {
      settle: params?.settle ?? vi.fn(async () => {}),
      abandon: params?.abandon ?? vi.fn(async () => {}),
      cancel: params?.cancel ?? vi.fn(async () => {}),
    },
  } as unknown as DiscordInboundJob;
}

describe("createDiscordMessageRunQueue", () => {
  it("abandons durable ingress when a queued run produces no visible dispatch", async () => {
    const settle = vi.fn(async () => {});
    const abandon = vi.fn(async () => {});
    const processDiscordMessage = vi.fn(async () => ({ kind: "no-visible-dispatch" as const }));
    const queue = createDiscordMessageRunQueue({
      runtime: createRuntime(),
      testing: { processDiscordMessage },
    });

    queue.enqueue(createJob({ settle, abandon }));

    await vi.waitFor(() => expect(abandon).toHaveBeenCalledOnce());
    expect(settle).not.toHaveBeenCalled();
    await queue.deactivate();
  });

  it("settles durable ingress when a queued run produces a visible dispatch", async () => {
    const settle = vi.fn(async () => {});
    const abandon = vi.fn(async () => {});
    const processDiscordMessage = vi.fn(async () => ({ kind: "visible-dispatch" as const }));
    const queue = createDiscordMessageRunQueue({
      runtime: createRuntime(),
      testing: { processDiscordMessage },
    });

    queue.enqueue(createJob({ settle, abandon }));

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    expect(abandon).not.toHaveBeenCalled();
    await queue.deactivate();
  });
});
