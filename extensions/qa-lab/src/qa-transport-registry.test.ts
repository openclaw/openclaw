// Qa Lab tests cover qa transport registry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import {
  createQaTransportAdapter,
  createQaTransportAdapterFactoryRegistry,
  normalizeQaTransportId,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
} from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";

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
    await created.cleanup();
  });

  it("selects an injected matching factory", async () => {
    const adapter = createQaChannelTransport(createQaBusState());
    const skippedCreate = vi.fn(async () => adapter);
    const selectedCreate = vi.fn(async () => adapter);
    const factories: QaTransportAdapterFactory[] = [
      { id: "skipped", matches: () => false, create: skippedCreate },
      { id: "selected", matches: () => true, create: selectedCreate },
    ];
    const registry = createQaTransportAdapterFactoryRegistry(factories);

    const created = await registry.create(createFactoryContext());

    expect(created.adapter).toBe(adapter);
    expect(skippedCreate).not.toHaveBeenCalled();
    expect(selectedCreate).toHaveBeenCalledOnce();
  });

  it("returns cleanup owned by the selected adapter", async () => {
    const cleanup = vi.fn(async () => undefined);
    const adapter: QaTransportAdapter = createQaChannelTransport(createQaBusState());
    adapter.cleanup = cleanup;
    const factory: QaTransportAdapterFactory = {
      id: "cleanup",
      matches: () => true,
      async create() {
        return adapter;
      },
    };
    const registry = createQaTransportAdapterFactoryRegistry([factory]);
    const created = await registry.create(createFactoryContext());

    await created.cleanup();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports no-match and startup failures with transport context", async () => {
    const context = createFactoryContext();
    const emptyRegistry = createQaTransportAdapterFactoryRegistry([]);
    await expect(emptyRegistry.create(context)).rejects.toThrow(
      "no QA transport factory for qa-channel:qa-channel",
    );

    const brokenRegistry = createQaTransportAdapterFactoryRegistry([
      {
        id: "broken",
        matches: () => true,
        async create() {
          throw new Error("provider boot failed");
        },
      },
    ]);
    await expect(brokenRegistry.create(context)).rejects.toThrow(
      "broken failed to create QA transport qa-channel:qa-channel: provider boot failed",
    );
  });
});
