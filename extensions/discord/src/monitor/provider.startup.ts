import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import {
  Client,
  ReadyListener,
  type BaseMessageInteractiveComponent,
  type DiscordCommand,
  type Modal,
  type RegisteredPlugin,
} from "../internal/discord.js";
import { VoicePlugin } from "../internal/voice.js";
import { parseApplicationIdFromToken } from "../probe.js";
import { DISCORD_REST_TIMEOUT_MS } from "../proxy-request-client.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import type { DiscordDmPolicy } from "./dm-command-auth.js";
import {
  createDiscordGatewayPlugin,
  waitForDiscordGatewayPluginRegistration,
} from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { DiscordGuildJoinIntroductionListener } from "./listeners.guild-join.js";
import {
  DiscordMessageListener,
  DiscordPresenceGuildCreateListener,
  DiscordPresenceGuildDeleteListener,
  DiscordInteractionListener,
  DiscordPresenceListener,
  DiscordPresenceReadyListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadDeleteListener,
  DiscordThreadReadyListener,
  DiscordThreadUpdateListener,
  registerDiscordListener,
} from "./listeners.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

type DiscordAutoPresenceController = ReturnType<typeof createDiscordAutoPresenceController>;
type DiscordListenerConfig = {
  dangerouslyAllowNameMatching?: boolean;
  intents?: { presence?: boolean };
};
type CreateClientFn = (
  options: ConstructorParameters<typeof Client>[0],
  handlers: ConstructorParameters<typeof Client>[1],
  plugins: ConstructorParameters<typeof Client>[2],
) => Client;
type DiscordEventQueueOptions = NonNullable<ConstructorParameters<typeof Client>[0]["eventQueue"]>;

export async function createDiscordMonitorClient(params: {
  scheduler: PluginServiceSchedulerV1;
  accountId: string;
  applicationId: string;
  token: string;
  restFetch?: typeof fetch;
  commands: DiscordCommand[];
  components: BaseMessageInteractiveComponent[];
  modals: Modal[];
  voiceEnabled: boolean;
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0];
  runtime: RuntimeEnv;
  commandDeployHashStore?: DiscordCommandDeployHashStore;
  createClient: CreateClientFn;
  isDisallowedIntentsError: (err: unknown) => boolean;
}) {
  let autoPresenceController: DiscordAutoPresenceController | null = null;
  const constructorPlugins: RegisteredPlugin[] = [createDiscordGatewayPlugin(params)];
  const voicePlugin = params.voiceEnabled ? new VoicePlugin() : undefined;

  const eventQueueOpts = {
    listenerTimeout: 120_000,
    slowListenerThreshold: 30_000,
  } satisfies DiscordEventQueueOptions;
  const readyDiscordConfig = params.discordConfig;
  const readyListener = new (class DiscordStatusReadyListener extends ReadyListener {
    async handle(_data: unknown, client: Client) {
      if (autoPresenceController?.enabled) {
        void autoPresenceController.refresh();
        return;
      }
      client.getPlugin("gateway")?.updatePresence(resolveDiscordPresenceUpdate(readyDiscordConfig));
    }
  })();
  const client = params.createClient(
    {
      clientId: params.applicationId,
      token: params.token,
      commandDeployHashStore: params.commandDeployHashStore,
      requestOptions: {
        timeout: DISCORD_REST_TIMEOUT_MS,
        ...(params.restFetch ? { fetch: params.restFetch } : {}),
      },
      eventQueue: eventQueueOpts,
    },
    {
      commands: params.commands,
      listeners: [readyListener],
      components: params.components,
      modals: params.modals,
    },
    constructorPlugins,
  );
  if (voicePlugin) {
    voicePlugin.registerClient?.(client);
    if (!client.plugins.some((entry) => entry.id === voicePlugin.id)) {
      client.plugins.push(voicePlugin);
    }
  }
  const gateway = client.getPlugin("gateway");
  await waitForDiscordGatewayPluginRegistration(gateway);
  const gatewaySupervisor = createDiscordGatewaySupervisor({
    ...params,
    gateway,
  });

  if (gateway) {
    autoPresenceController = createDiscordAutoPresenceController({
      ...params,
      gateway,
      log: (message) => params.runtime.log?.(message),
    });
    void autoPresenceController.start();
  }

  return {
    client,
    gateway,
    gatewaySupervisor,
    autoPresenceController,
    eventQueueOpts,
  };
}

export async function fetchDiscordBotIdentity(params: {
  client: Pick<Client, "fetchUser">;
  token?: string;
  runtime: RuntimeEnv;
  logStartupPhase: (phase: string, details?: string) => void;
}) {
  params.logStartupPhase("fetch-bot-identity:start");
  const parsedBotUserId = parseApplicationIdFromToken(params.token ?? "");
  if (parsedBotUserId) {
    params.logStartupPhase(
      "fetch-bot-identity:done",
      `botUserId=${parsedBotUserId} botUserName=<missing> source=token`,
    );
    return { botUserId: parsedBotUserId, botUserName: undefined };
  }

  let botUser: Awaited<ReturnType<typeof params.client.fetchUser>>;
  try {
    botUser = await params.client.fetchUser("@me");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
    params.logStartupPhase("fetch-bot-identity:error", String(err));
    throw new Error("Failed to resolve Discord bot identity", { cause: err });
  }

  const botUserId = normalizeOptionalString(botUser?.id);
  const botUserName =
    normalizeOptionalString(botUser?.username) ?? normalizeOptionalString(botUser?.globalName);
  if (!botUserId) {
    const details = 'fetchUser("@me") returned no usable id';
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${details}`));
    params.logStartupPhase("fetch-bot-identity:error", details);
    throw new Error("Failed to resolve Discord bot identity");
  }

  params.logStartupPhase(
    "fetch-bot-identity:done",
    `botUserId=${botUserId} botUserName=${botUserName ?? "<missing>"}`,
  );
  return { botUserId, botUserName };
}

export function registerDiscordMonitorListeners(params: {
  readPolicy?: DiscordLivePolicyReader;
  cfg: OpenClawConfig;
  client: Pick<Client, "listeners">;
  accountId: string;
  discordConfig: DiscordListenerConfig;
  runtime: RuntimeEnv;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: DiscordDmPolicy;
  allowFrom?: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: NonNullable<ConstructorParameters<typeof DiscordMessageListener>[1]>;
  messageHandler: ConstructorParameters<typeof DiscordMessageListener>[0];
  trackInboundEvent?: () => void;
}) {
  const register = (...listeners: object[]) => {
    for (const listener of listeners) {
      registerDiscordListener(params.client.listeners, listener);
    }
  };
  register(
    new DiscordInteractionListener(params.logger, params.trackInboundEvent),
    new DiscordMessageListener(params.messageHandler, params.logger, params.trackInboundEvent),
  );
  const listenerOptions = {
    readPolicy: params.readPolicy,
    cfg: params.cfg,
    accountId: params.accountId,
    botUserId: params.botUserId,
    guildEntries: params.guildEntries,
    logger: params.logger,
  };
  const guildJoinListener = new DiscordGuildJoinIntroductionListener({
    ...listenerOptions,
    groupPolicy: params.groupPolicy,
  });
  register(guildJoinListener);

  const reactionListenerOptions: ConstructorParameters<typeof DiscordReactionListener>[0] = {
    ...listenerOptions,
    runtime: params.runtime,
    dmEnabled: params.dmEnabled,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels: params.groupDmChannels ?? [],
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom ?? [],
    groupPolicy: params.groupPolicy,
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
    onEvent: params.trackInboundEvent,
  };
  register(
    new DiscordReactionListener(reactionListenerOptions),
    new DiscordReactionRemoveListener(reactionListenerOptions),
  );
  const threadUpdateListener = new DiscordThreadUpdateListener(params.cfg, params.logger);
  register(
    threadUpdateListener,
    new DiscordThreadReadyListener(threadUpdateListener),
    new DiscordThreadDeleteListener(params.cfg, params.accountId, params.logger),
  );

  let presenceListener: DiscordPresenceListener | undefined;
  if (params.discordConfig.intents?.presence) {
    presenceListener = new DiscordPresenceListener(listenerOptions);
    register(
      presenceListener,
      new DiscordPresenceGuildCreateListener(presenceListener),
      new DiscordPresenceGuildDeleteListener(presenceListener),
      new DiscordPresenceReadyListener(presenceListener),
    );
    params.runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
  }
  return async () => {
    const introductionsStopped = guildJoinListener.stop();
    try {
      await presenceListener?.stop();
    } finally {
      await introductionsStopped;
    }
  };
}
