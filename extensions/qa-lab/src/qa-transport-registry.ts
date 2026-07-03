// Qa Lab plugin module implements qa transport registry behavior.
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import type { QaBusState } from "./bus-state.js";
import type { QaProviderMode } from "./model-selection.js";
import {
  createQaChannelTransport,
  QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY,
} from "./qa-channel-transport.js";
import {
  createQaTransportCapabilityManifest,
  createQaTransportMissingCapabilitiesError,
  createQaTransportStartupFailureError,
  QaTransportContractError,
  type QaTransportCapability,
  type QaTransportCapabilityManifest,
  type QaTransportOperation,
} from "./qa-transport-contracts.js";
import type { QaTransportAdapter } from "./qa-transport.js";

export type QaTransportId = "qa-channel";
export type QaTransportDriver = QaTransportId | "crabline";

export type QaTransportCredentialLease = {
  credentialId?: string;
  role?: string;
  source: "convex" | "env";
};

export type QaTransportFactoryContext = {
  accountId?: string;
  channelId: string;
  credentialLease?: QaTransportCredentialLease;
  driver: QaTransportDriver;
  outputDir: string;
  provider: {
    alternateModel: string;
    mode: QaProviderMode;
    primaryModel: string;
  };
  requestedCapabilities: readonly QaTransportCapability[];
  state: QaBusState;
};

export type QaTransportAdapterFactoryResult = {
  adapter: QaTransportAdapter;
  capabilityManifest: QaTransportCapabilityManifest;
  cleanup: () => Promise<void>;
};

export type QaTransportAdapterFactory = {
  id: string;
  matches: (context: Pick<QaTransportFactoryContext, "channelId" | "driver">) => boolean;
  resolveCapabilityManifest: (
    context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
  ) => Promise<QaTransportCapabilityManifest>;
  create: (context: QaTransportFactoryContext) => Promise<QaTransportAdapter>;
};

export type QaTransportAdapterFactoryRegistry = {
  create: (context: QaTransportFactoryContext) => Promise<QaTransportAdapterFactoryResult>;
  resolveCapabilityManifest: (
    context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
  ) => Promise<QaTransportCapabilityManifest>;
};

const DEFAULT_QA_TRANSPORT_ID: QaTransportId = "qa-channel";

const QA_CHANNEL_CAPABILITIES = [
  "commands.native",
  "identity.bot",
  "mentions.structured",
  "messages.attachments",
  "messages.chunk-lifecycle",
  "messages.deletes",
  "messages.edits",
  "messages.preview-lifecycle",
  "messages.structured",
  "messages.text",
  "relations.reactions",
  "relations.redactions",
  "relations.replies",
  "relations.threads",
] as const satisfies readonly QaTransportCapability[];

const QA_CHANNEL_OPERATIONS = [
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
] as const satisfies readonly QaTransportOperation[];

const CRABLINE_BASELINE_CAPABILITIES = [
  "identity.bot",
  "messages.text",
] as const satisfies readonly QaTransportCapability[];

const CRABLINE_BASELINE_OPERATIONS = [
  "message.send-inbound",
  "message.wait-for-none",
  "message.wait-for-outbound",
  "message.wait-for-outbound-sequence",
  "state.read",
  "state.reset",
] as const satisfies readonly QaTransportOperation[];

function createQaChannelCapabilityManifest() {
  return createQaTransportCapabilityManifest({
    adapterId: "qa-channel",
    channelId: "qa-channel",
    driver: "qa-channel",
    capabilities: QA_CHANNEL_CAPABILITIES,
    operations: QA_CHANNEL_OPERATIONS,
  });
}

function createCrablineCapabilityManifest(channelId: string) {
  const isTelegram = channelId === "telegram";
  return createQaTransportCapabilityManifest({
    adapterId: "crabline",
    channelId,
    driver: "crabline",
    capabilities: [
      ...CRABLINE_BASELINE_CAPABILITIES,
      ...(isTelegram ? (["commands.native", "messages.preview-lifecycle"] as const) : []),
    ],
    operations: [
      ...CRABLINE_BASELINE_OPERATIONS,
      ...(isTelegram ? (["message.send-native-command"] as const) : []),
    ],
  });
}

const QA_CHANNEL_TRANSPORT_FACTORY: QaTransportAdapterFactory = {
  id: "qa-channel",
  matches: ({ channelId, driver }) => driver === "qa-channel" && channelId === "qa-channel",
  async resolveCapabilityManifest() {
    return createQaChannelCapabilityManifest();
  },
  async create(context) {
    return createQaChannelTransport(context.state);
  },
};

const CRABLINE_TRANSPORT_FACTORY: QaTransportAdapterFactory = {
  id: "crabline",
  matches: ({ driver }) => driver === "crabline",
  async resolveCapabilityManifest({ channelId }) {
    const { resolveOpenClawCrablineChannelDriverSelection } = await import("@openclaw/crabline");
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: channelId });
    return createCrablineCapabilityManifest(selection.channel);
  },
  async create(context) {
    const { resolveOpenClawCrablineChannelDriverSelection } = await import("@openclaw/crabline");
    const selection: OpenClawCrablineChannelDriverSelection =
      resolveOpenClawCrablineChannelDriverSelection({ channel: context.channelId });
    const { createQaCrablineTransportAdapter } = await import("./crabline-transport.js");
    return await createQaCrablineTransportAdapter({
      outputDir: context.outputDir,
      selection,
      state: context.state,
    });
  },
};

const DEFAULT_QA_TRANSPORT_FACTORIES = [
  QA_CHANNEL_TRANSPORT_FACTORY,
  CRABLINE_TRANSPORT_FACTORY,
] as const;

function findQaTransportFactory(
  factories: readonly QaTransportAdapterFactory[],
  context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
) {
  return factories.find((factory) => factory.matches(context));
}

function requireQaTransportFactory(
  factories: readonly QaTransportAdapterFactory[],
  context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
) {
  const factory = findQaTransportFactory(factories, context);
  if (factory) {
    return factory;
  }
  throw createQaTransportStartupFailureError({
    cause: `no QA transport factory for ${context.driver}:${context.channelId}`,
    factoryId: "qa-transport-registry",
    transportId: `${context.driver}:${context.channelId}`,
  });
}

export function assertQaTransportAdapterMethodSupport(params: {
  adapter: QaTransportAdapter;
  manifest: QaTransportCapabilityManifest;
}): void {
  const declaredOperations = [...params.manifest.operations].toSorted();
  const supportedOperations = [...params.adapter.supportedOperations].toSorted();
  if (JSON.stringify(declaredOperations) !== JSON.stringify(supportedOperations)) {
    throw new Error(
      `${params.adapter.id} manifest operations do not match adapter support: declared=${declaredOperations.join(",")} supported=${supportedOperations.join(",")}`,
    );
  }

  const methodByOperation = {
    "action.delete": params.adapter.handleAction,
    "action.edit": params.adapter.handleAction,
    "action.react": params.adapter.handleAction,
    "action.thread-create": params.adapter.handleAction,
    "message.send-inbound": params.adapter.sendInbound,
    "message.send-native-command": params.adapter.sendNativeCommand,
    "message.wait-for-none": params.adapter.waitForNoOutbound,
    "message.wait-for-outbound": params.adapter.waitForOutbound,
    "message.wait-for-outbound-sequence": params.adapter.waitForOutboundSequence,
    "state.read": params.adapter.state.getSnapshot,
    "state.reset": params.adapter.reset,
  } satisfies Record<QaTransportOperation, unknown>;

  for (const operation of params.manifest.operations) {
    if (typeof methodByOperation[operation] !== "function") {
      throw new Error(`${params.adapter.id} declares ${operation} without an adapter method`);
    }
  }
}

export function createQaTransportAdapterFactoryRegistry(
  factories: readonly QaTransportAdapterFactory[] = DEFAULT_QA_TRANSPORT_FACTORIES,
): QaTransportAdapterFactoryRegistry {
  return {
    async resolveCapabilityManifest(context) {
      const factory = requireQaTransportFactory(factories, context);
      try {
        return await factory.resolveCapabilityManifest(context);
      } catch (error) {
        if (error instanceof QaTransportContractError) {
          throw error;
        }
        throw createQaTransportStartupFailureError({
          cause: error,
          factoryId: factory.id,
          transportId: `${context.driver}:${context.channelId}`,
        });
      }
    },
    async create(context) {
      const factory = requireQaTransportFactory(factories, context);
      const capabilityManifest = await this.resolveCapabilityManifest(context);
      const missingCapabilitiesError = createQaTransportMissingCapabilitiesError({
        manifest: capabilityManifest,
        requestedCapabilities: context.requestedCapabilities,
      });
      if (missingCapabilitiesError) {
        throw missingCapabilitiesError;
      }

      let adapter: QaTransportAdapter;
      try {
        adapter = await factory.create(context);
      } catch (error) {
        if (error instanceof QaTransportContractError) {
          throw error;
        }
        throw createQaTransportStartupFailureError({
          cause: error,
          factoryId: factory.id,
          transportId: capabilityManifest.transport.adapterId,
        });
      }

      try {
        assertQaTransportAdapterMethodSupport({ adapter, manifest: capabilityManifest });
      } catch (error) {
        await adapter.cleanup?.().catch(() => undefined);
        throw createQaTransportStartupFailureError({
          cause: error,
          factoryId: factory.id,
          transportId: capabilityManifest.transport.adapterId,
        });
      }

      return {
        adapter,
        capabilityManifest,
        cleanup: async () => {
          await adapter.cleanup?.();
        },
      };
    },
  };
}

export const qaTransportAdapterFactoryRegistry = createQaTransportAdapterFactoryRegistry();

export function normalizeQaTransportId(input?: string | null): QaTransportId {
  const transportId = input?.trim() || DEFAULT_QA_TRANSPORT_ID;
  if (transportId === "qa-channel") {
    return transportId;
  }
  throw new Error(`unsupported QA transport: ${transportId}`);
}

export async function createQaTransportAdapter(
  params: QaTransportFactoryContext,
): Promise<QaTransportAdapterFactoryResult> {
  return await qaTransportAdapterFactoryRegistry.create(params);
}

export function defaultQaSuiteConcurrencyForTransport(id: QaTransportId): number {
  return id === "qa-channel" ? QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY : 1;
}
