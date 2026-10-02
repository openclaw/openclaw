import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaTransportAdapter,
  normalizeQaTransportId,
  qaTransportSupportsModuleFlows,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
} from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";

const fail = (message: string) => Promise.reject(new Error(message));

function createAdapterDefinition(
  cleanup?: () => Promise<void>,
  cleanupAfterGatewayStop?: () => Promise<void>,
) {
  const state = createQaBusState();
  return {
    id: "selected",
    label: "Selected",
    accountId: "sut",
    requiredPluginIds: [],
    supportedActions: [],
    sendInbound: async (input: Parameters<QaTransportAdapter["sendInbound"]>[0]) =>
      state.addInboundMessage(input),
    createGatewayConfig: () => ({}),
    async waitReady() {},
    buildAgentDelivery: ({ target }: { target: string }) => ({
      channel: "selected",
      to: target,
      replyChannel: "selected",
      replyTo: target,
    }),
    async handleAction() {},
    createReportNotes: () => [],
    ...(cleanup ? { cleanup } : {}),
    ...(cleanupAfterGatewayStop ? { cleanupAfterGatewayStop } : {}),
  };
}

function createFactoryContext(
  overrides: Partial<QaTransportFactoryContext> = {},
): QaTransportFactoryContext {
  return {
    channelId: "qa-channel",
    driver: "qa-channel",
    outputDir: ".artifacts/qa-e2e/transport-contract-test",
    state: createQaBusState(),
    ...overrides,
  };
}

function factory(
  create: QaTransportAdapterFactory["create"],
  overrides: Partial<QaTransportAdapterFactory> = {},
): QaTransportAdapterFactory {
  return { id: "cleanup", matches: () => true, create, ...overrides };
}

async function createCleanupAdapter(
  cleanup?: () => Promise<void>,
  cleanupAfterGatewayStop?: () => Promise<void>,
) {
  return await createQaTransportAdapter(
    createFactoryContext({ channelId: "cleanup", driver: "live" }),
    [factory(async () => createAdapterDefinition(cleanup, cleanupAfterGatewayStop))],
  );
}

describe("qa transport registry", () => {
  it("rejects inherited prototype keys as unsupported transport ids", () => {
    expect(() => normalizeQaTransportId("toString")).toThrow("unsupported QA transport: toString");
    expect(() => normalizeQaTransportId("__proto__")).toThrow(
      "unsupported QA transport: __proto__",
    );
  });

  it("creates QA Channel through the default async registry", async () => {
    const created = await createQaTransportAdapter(createFactoryContext());

    expect(created.adapter.id).toBe("qa-channel");
    await created.cleanupWithoutGateway();
  });

  const factories: QaTransportAdapterFactory[] = [
    { id: "skipped", matches: () => false, create: vi.fn() },
    { id: "selected", supportsModuleFlows: true, matches: () => true, create: vi.fn() },
  ];
  it.each<[readonly QaTransportAdapterFactory[] | undefined, string, "live" | "crabline", boolean]>(
    [
      [factories, "selected", "live", true],
      [[], "selected", "live", false],
      [undefined, "discord", "crabline", true],
      [undefined, "telegram", "crabline", false],
    ],
  )("reads module-flow support from %j for %s/%s", (registry, channelId, driver, expected) => {
    expect(qaTransportSupportsModuleFlows(registry, { channelId, driver })).toBe(expected);
  });

  it("rejects module-flow support when the created adapter lacks prepareFlow", async () => {
    const cleanup = vi.fn(() => fail("cleanup failed"));
    const cleanupAfterGatewayStop = vi.fn(async () => undefined);
    const selected = factory(
      async () => createAdapterDefinition(cleanup, cleanupAfterGatewayStop),
      { id: "selected", supportsModuleFlows: true },
    );

    await expect(
      createQaTransportAdapter(createFactoryContext({ channelId: "selected", driver: "live" }), [
        selected,
      ]),
    ).rejects.toThrow(
      'QA transport factory "selected" supports module flows but its adapter does not implement prepareFlow',
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
  });

  it("shares cleanup between concurrent gateway-less and phase-specific callers", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const cleanup = vi.fn(() => promise);
    const cleanupAfterGatewayStop = vi.fn(async () => undefined);
    const created = await createCleanupAdapter(cleanup, cleanupAfterGatewayStop);
    const attempts = [
      created.cleanupWithoutGateway(),
      created.cleanupWithoutGateway(),
      created.cleanupBeforeGatewayStop(),
    ];

    await Promise.resolve();
    try {
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      resolve();
      await Promise.allSettled(attempts);
    }

    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
    await created.cleanupWithoutGateway();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
  });

  it("runs post-gateway cleanup when gateway-less pre-cleanup fails", async () => {
    const cleanup = vi.fn(() => fail("pre-cleanup failed"));
    const cleanupAfterGatewayStop = vi.fn(async () => undefined);
    const created = await createCleanupAdapter(cleanup, cleanupAfterGatewayStop);

    await expect(created.cleanupWithoutGateway()).rejects.toThrow("pre-cleanup failed");
    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
  });

  it("aggregates failures from both gateway-less cleanup phases", async () => {
    const created = await createCleanupAdapter(
      () => fail("pre-cleanup failed"),
      () => fail("post-cleanup failed"),
    );

    const cleanupError = await created.cleanupWithoutGateway().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "pre-cleanup failed" }),
      expect.objectContaining({ message: "post-cleanup failed" }),
    ]);
  });

  it("reports no-match and startup failures with transport context", async () => {
    const context = createFactoryContext({ channelId: "missing", driver: "live" });
    await expect(createQaTransportAdapter(context, [])).rejects.toThrow(
      "no QA transport factory for live:missing",
    );

    await expect(
      createQaTransportAdapter(context, [
        factory(() => fail("provider boot failed"), { id: "broken" }),
      ]),
    ).rejects.toThrow("failed to create QA transport live:missing: provider boot failed");
  });
});
