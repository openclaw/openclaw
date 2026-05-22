import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { Client, type BaseCommand, type BaseMessageInteractiveComponent, type Modal } from "../internal/discord.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import type { DiscordDmPolicy } from "./dm-command-auth.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { DiscordMessageListener } from "./listeners.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
type DiscordListenerConfig = {
    dangerouslyAllowNameMatching?: boolean;
    intents?: {
        presence?: boolean;
    };
};
type CreateClientFn = (options: ConstructorParameters<typeof Client>[0], handlers: ConstructorParameters<typeof Client>[1], plugins: ConstructorParameters<typeof Client>[2]) => Client;
type DiscordEventQueueOptions = NonNullable<ConstructorParameters<typeof Client>[0]["eventQueue"]>;
export declare function createDiscordMonitorClient(params: {
    accountId: string;
    applicationId: string;
    token: string;
    restFetch?: typeof fetch;
    commands: BaseCommand[];
    components: BaseMessageInteractiveComponent[];
    modals: Modal[];
    voiceEnabled: boolean;
    discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0] & {
        eventQueue?: Pick<DiscordEventQueueOptions, "listenerTimeout" | "maxQueueSize" | "maxConcurrency">;
    };
    runtime: RuntimeEnv;
    createClient: CreateClientFn;
    createGatewayPlugin: typeof createDiscordGatewayPlugin;
    createGatewaySupervisor: typeof createDiscordGatewaySupervisor;
    createAutoPresenceController: typeof createDiscordAutoPresenceController;
    isDisallowedIntentsError: (err: unknown) => boolean;
}): Promise<{
    client: Client;
    gateway: MutableDiscordGateway | undefined;
    gatewaySupervisor: import("./gateway-supervisor.js").DiscordGatewaySupervisor;
    autoPresenceController: {
        start: () => void;
        stop: () => void;
        refresh: () => void;
        runNow: () => void;
        enabled: boolean;
    } | null;
    eventQueueOpts: {
        maxQueueSize?: number;
        maxConcurrency?: number;
        listenerTimeout: number;
        slowListenerThreshold: number;
    };
}>;
export declare function fetchDiscordBotIdentity(params: {
    client: Pick<Client, "fetchUser">;
    token?: string;
    runtime: RuntimeEnv;
    logStartupPhase: (phase: string, details?: string) => void;
}): Promise<{
    botUserId: string;
    botUserName: string | undefined;
}>;
export declare function registerDiscordMonitorListeners(params: {
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
}): void;
export {};
