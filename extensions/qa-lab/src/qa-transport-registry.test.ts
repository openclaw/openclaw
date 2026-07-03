// Qa Lab tests cover qa transport registry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import {
  QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION,
  QaTransportContractError,
  createQaTransportCapabilityManifest,
} from "./qa-transport-contracts.js";
import {
  assertQaTransportAdapterMethodSupport,
  createQaTransportAdapterFactoryRegistry,
  normalizeQaTransportId,
  qaTransportAdapterFactoryRegistry,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
} from "./qa-transport-registry.js";

function createFactoryContext(
  overrides: Partial<QaTransportFactoryContext> = {},
): QaTransportFactoryContext {
  return {
    channelId: "qa-channel",
    driver: "qa-channel",
    outputDir: ".artifacts/qa-e2e/transport-contract-test",
    provider: {
      alternateModel: "mock-openai/gpt-5.5-alt",
      mode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
    },
    requestedCapabilities: [],
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

  it("declares versioned capability manifests for QA Channel and Crabline", async () => {
    const qaChannel = await qaTransportAdapterFactoryRegistry.resolveCapabilityManifest({
      channelId: "qa-channel",
      driver: "qa-channel",
    });
    const crablineTelegram = await qaTransportAdapterFactoryRegistry.resolveCapabilityManifest({
      channelId: "telegram",
      driver: "crabline",
    });

    expect(qaChannel.schemaVersion).toBe(QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION);
    expect(qaChannel.capabilities).toContain("messages.preview-lifecycle");
    expect(qaChannel.operations).toContain("message.wait-for-outbound-sequence");
    expect(crablineTelegram).toMatchObject({
      schemaVersion: QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION,
      transport: {
        adapterId: "crabline",
        channelId: "telegram",
        driver: "crabline",
      },
    });
    expect(crablineTelegram.capabilities).toContain("messages.preview-lifecycle");
    expect(crablineTelegram.operations).toContain("message.send-native-command");

    const created = await qaTransportAdapterFactoryRegistry.create(
      createFactoryContext({ requestedCapabilities: ["messages.text"] }),
    );
    expect(created.adapter.supportedOperations).toStrictEqual(qaChannel.operations);
    await created.cleanup();
  });

  it("fails missing capability requests before adapter startup", async () => {
    const create = vi.fn(() => Promise.resolve(createQaChannelTransport(createQaBusState())));
    const factory: QaTransportAdapterFactory = {
      id: "text-only",
      matches: () => true,
      async resolveCapabilityManifest() {
        return createQaTransportCapabilityManifest({
          adapterId: "text-only",
          channelId: "qa-channel",
          driver: "qa-channel",
          capabilities: ["messages.text"],
          operations: [
            "action.delete",
            "action.edit",
            "action.react",
            "action.thread-create",
            "message.send-inbound",
            "message.send-native-command",
            "message.wait-for-none",
            "message.wait-for-outbound",
            "message.wait-for-outbound-sequence",
            "state.read",
            "state.reset",
          ],
        });
      },
      create,
    };
    const registry = createQaTransportAdapterFactoryRegistry([factory]);

    await expect(
      registry.create(
        createFactoryContext({ requestedCapabilities: ["messages.polls", "messages.text"] }),
      ),
    ).rejects.toMatchObject({
      normalized: {
        code: "missing_capabilities",
        missingCapabilities: ["messages.polls"],
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes adapter startup failures", async () => {
    const factory: QaTransportAdapterFactory = {
      id: "broken",
      matches: () => true,
      async resolveCapabilityManifest() {
        return createQaTransportCapabilityManifest({
          adapterId: "broken",
          channelId: "qa-channel",
          driver: "qa-channel",
          capabilities: ["messages.text"],
          operations: [],
        });
      },
      async create() {
        throw new Error("provider server refused startup");
      },
    };
    const registry = createQaTransportAdapterFactoryRegistry([factory]);

    await expect(registry.create(createFactoryContext())).rejects.toMatchObject({
      normalized: {
        code: "startup_failure",
        factoryId: "broken",
        message: "provider server refused startup",
      },
    });
  });

  it("normalizes blank adapter startup failures", async () => {
    const factory: QaTransportAdapterFactory = {
      id: "blank-failure",
      matches: () => true,
      async resolveCapabilityManifest() {
        return createQaTransportCapabilityManifest({
          adapterId: "blank-failure",
          channelId: "qa-channel",
          driver: "qa-channel",
          capabilities: ["messages.text"],
          operations: [],
        });
      },
      async create() {
        throw new Error("");
      },
    };

    await expect(
      createQaTransportAdapterFactoryRegistry([factory]).create(createFactoryContext()),
    ).rejects.toMatchObject({
      normalized: {
        code: "startup_failure",
        message: "unknown transport startup failure",
      },
    });
  });

  it("rejects capability manifests that overstate adapter method support", () => {
    const adapter = createQaChannelTransport(createQaBusState());
    const manifest = createQaTransportCapabilityManifest({
      adapterId: adapter.id,
      channelId: adapter.id,
      driver: adapter.id,
      capabilities: ["messages.text"],
      operations: adapter.supportedOperations.filter(
        (operation) => operation !== "message.wait-for-outbound-sequence",
      ),
    });

    expect(() => assertQaTransportAdapterMethodSupport({ adapter, manifest })).toThrow(
      "manifest operations do not match adapter support",
    );
  });

  it("uses the closed transport contract error type", async () => {
    await expect(
      createQaTransportAdapterFactoryRegistry([]).create(createFactoryContext()),
    ).rejects.toBeInstanceOf(QaTransportContractError);
  });
});
