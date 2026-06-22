// Qa Lab plugin module implements the Crabline-backed QA transport.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ManifestDefinition, ProviderAdapter, ProviderContext, Registry } from "crabline";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import type { QaCrablineChannelDriverSelection } from "./crabline-channel-driver.js";
import {
  createQaCrablineManifestInput,
  parseQaCrablineManifest,
  type QaCrablineManifestSchema,
} from "./crabline-manifest.js";
import {
  createQaChannelGatewayConfig,
  QA_CHANNEL_REQUIRED_PLUGIN_IDS,
} from "./qa-channel-transport.js";
import { QaStateBackedTransportAdapter } from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayClient,
  QaTransportReportParams,
  QaTransportState,
} from "./qa-transport.js";
import type {
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusReactToMessageInput,
} from "./runtime-api.js";

const CRABLINE_TRANSPORT_ID = "crabline";

export type QaCrablineProviderAdapter = ProviderAdapter;

type CrablineRuntimeModule = {
  ManifestSchema: QaCrablineManifestSchema;
  createRegistry: (manifest: ManifestDefinition, manifestPath: string) => Registry;
};

type CrablineRuntime = {
  provider?: QaCrablineProviderAdapter;
};

type QaCrablineTransportState = QaTransportState & {
  cleanup: () => Promise<void>;
  createThread: (input: QaBusCreateThreadInput) => unknown;
  deleteMessage: (input: QaBusDeleteMessageInput) => unknown;
  editMessage: (input: QaBusEditMessageInput) => unknown;
  reactToMessage: (input: QaBusReactToMessageInput) => unknown;
};

type CrablineStateParams = {
  fixtureContext: ProviderContext;
  provider: QaCrablineProviderAdapter;
  selection: QaCrablineChannelDriverSelection;
  state: QaBusState;
};

async function loadCrablineRuntime(env: NodeJS.ProcessEnv): Promise<CrablineRuntimeModule> {
  const explicitRuntime = env.OPENCLAW_QA_CRABLINE_RUNTIME?.trim();
  if (explicitRuntime) {
    return (await import(
      pathToFileURL(path.resolve(explicitRuntime)).href
    )) as unknown as CrablineRuntimeModule;
  }
  return (await import("crabline")) as unknown as CrablineRuntimeModule;
}

function createFixtureContext(params: {
  fixtureId: string;
  manifest: ManifestDefinition;
  manifestPath: string;
  providerId: string;
}): ProviderContext {
  const fixture = params.manifest.fixtures.find((entry) => entry.id === params.fixtureId);
  const config = params.manifest.providers[params.providerId];
  if (!fixture || !config) {
    throw new Error("Crabline manifest is missing its runtime fixture/provider.");
  }
  return {
    config,
    fixture,
    manifestPath: params.manifestPath,
    providerId: params.providerId,
    userName: params.manifest.userName,
  };
}

function targetForConversation(message: QaBusMessage) {
  return `${message.conversation.kind === "direct" ? "dm" : "channel"}:${message.conversation.id}`;
}

function withTarget(context: ProviderContext, targetId: string): ProviderContext {
  return {
    ...context,
    fixture: {
      ...context.fixture,
      target: {
        id: targetId,
        metadata: {},
      },
    },
  };
}

function createCrablineState(params: CrablineStateParams): QaCrablineTransportState {
  const baseState = params.state;

  return {
    reset() {
      return baseState.reset();
    },
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const inbound = baseState.addInboundMessage(input);
      const targetId = targetForConversation(inbound);
      const context = withTarget(params.fixtureContext, targetId);
      await params.provider.send({
        ...context,
        mode: "send",
        nonce: inbound.id,
        text: input.text,
      });
      return inbound;
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    createThread: baseState.createThread.bind(baseState),
    deleteMessage: baseState.deleteMessage.bind(baseState),
    editMessage: baseState.editMessage.bind(baseState),
    reactToMessage: baseState.reactToMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    searchMessages: baseState.searchMessages.bind(baseState),
    waitFor: baseState.waitFor.bind(baseState),
    async cleanup() {
      await params.provider.cleanup?.();
    },
  };
}

class QaCrablineTransport extends QaStateBackedTransportAdapter {
  readonly #selection: QaCrablineChannelDriverSelection;
  readonly #state: QaCrablineTransportState;

  constructor(params: {
    selection: QaCrablineChannelDriverSelection;
    state: QaCrablineTransportState;
  }) {
    super({
      id: CRABLINE_TRANSPORT_ID,
      label: `crabline + ${params.selection.channel}`,
      accountId: `qa-crabline-${params.selection.channel}`,
      requiredPluginIds: QA_CHANNEL_REQUIRED_PLUGIN_IDS,
      state: params.state,
    });
    this.#selection = params.selection;
    this.#state = params.state;
  }

  createGatewayConfig = createQaChannelGatewayConfig;

  createChannelDriverSmokeEnv = (env: NodeJS.ProcessEnv) => ({ ...env });

  waitReady = async (_params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => {};

  buildAgentDelivery = ({ target }: { target: string }) => ({
    channel: "qa-channel",
    replyChannel: "qa-channel",
    replyTo: target,
  });

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: unknown;
    accountId?: string | null;
  }) => {
    const accountId = _params.accountId?.trim() || this.accountId;
    switch (_params.action) {
      case "thread-create":
        return {
          thread: this.#state.createThread({
            ...(_params.args as unknown as QaBusCreateThreadInput),
            accountId,
          }),
        };
      case "react":
        return {
          message: this.#state.reactToMessage({
            ...(_params.args as unknown as QaBusReactToMessageInput),
            accountId,
          }),
        };
      case "edit":
        return {
          message: this.#state.editMessage({
            ...(_params.args as unknown as QaBusEditMessageInput),
            accountId,
          }),
        };
      case "delete":
        return {
          message: this.#state.deleteMessage({
            ...(_params.args as unknown as QaBusDeleteMessageInput),
            accountId,
          }),
        };
      default:
        throw new Error(`unsupported Crabline action: ${String(_params.action)}`);
    }
  };

  createReportNotes = (_params: QaTransportReportParams) => [
    `Runs ${this.#selection.channel}-shaped QA messages through openclaw/crabline.`,
    "No live channel service or external credential lease is required.",
  ];

  async cleanup() {
    await this.#state.cleanup();
  }
}

export async function createQaCrablineTransportAdapter(params: {
  env?: NodeJS.ProcessEnv;
  observeIdleMs?: number;
  observeTimeoutMs?: number;
  outputDir: string;
  runtime?: CrablineRuntime;
  selection: QaCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  const env = params.env ?? process.env;
  await fs.mkdir(path.join(params.outputDir, "artifacts", "crabline"), {
    recursive: true,
  });
  const { fixtureId, manifest: manifestInput } = createQaCrablineManifestInput(
    params.selection.channel,
  );
  const manifestPath = path.join(params.outputDir, "crabline-runtime.json");
  const runtime = await loadCrablineRuntime(env);
  const manifest = parseQaCrablineManifest(runtime.ManifestSchema, manifestInput);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const provider =
    params.runtime?.provider ??
    runtime.createRegistry(manifest, manifestPath).resolve(params.selection.channel, fixtureId);
  const fixtureContext = createFixtureContext({
    fixtureId,
    manifest,
    manifestPath,
    providerId: params.selection.channel,
  });

  return new QaCrablineTransport({
    selection: params.selection,
    state: createCrablineState({
      fixtureContext,
      provider,
      selection: params.selection,
      state: params.state ?? createQaBusState(),
    }),
  });
}
