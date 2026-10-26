import type { APIInteraction } from "discord-api-types/v10";
import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { DiscordCommandDeployer } from "./command-deploy.js";
import type { DiscordCommand } from "./commands.js";
import { BaseMessageInteractiveComponent, parseCustomId } from "./components.base.js";
import type { Modal } from "./components.modal.js";
import { DiscordEntityCache } from "./entity-cache.js";
import { dispatchInteraction } from "./interaction-dispatch.js";
import type { GatewayPluginContract, VoicePluginContract } from "./plugin-contract.js";
import { RequestClient, type RequestClientOptions } from "./rest.js";
import type { Guild, GuildMember, User } from "./structures.js";

class ComponentRegistry<
  T extends { customId: string; customIdParser?: typeof parseCustomId; type?: number },
> {
  private entries = new Map<string, T[]>();
  private wildcardEntries: T[] = [];

  register(entry: T): void {
    const key = (entry.customIdParser ?? parseCustomId)(entry.customId).key;
    const entries = key === "*" ? this.wildcardEntries : (this.entries.get(key) ?? []);
    if (!entries.includes(entry)) {
      entries.push(entry);
      if (key !== "*") {
        this.entries.set(key, entries);
      }
    }
  }

  resolve(customId: string, options?: { componentType?: number }): T | undefined {
    for (const entries of this.entries.values()) {
      const match = entries.find((entry) => {
        if (options?.componentType !== undefined && entry.type !== options.componentType) {
          return false;
        }
        const parser = entry.customIdParser ?? parseCustomId;
        return parser(entry.customId).key === parser(customId).key;
      });
      if (match) {
        return match;
      }
    }
    return this.wildcardEntries.find(
      (entry) => options?.componentType === undefined || entry.type === options.componentType,
    );
  }
}

export type RegisteredPlugin = (GatewayPluginContract | VoicePluginContract) & {
  registerClient?(client: Client): Promise<void> | void;
};

type AnyListener = {
  type: string;
  handle(data: unknown, client: Client): Promise<void> | void;
};

type DiscordEventQueueOptions = {
  maxQueueSize?: number;
  maxConcurrency?: number;
};

interface ClientOptions {
  clientId: string;
  token: string;
  requestOptions?: RequestClientOptions;
  commandDeployHashStore?: DiscordCommandDeployHashStore;
  eventQueue?: DiscordEventQueueOptions;
}

export class Client {
  plugins: RegisteredPlugin[] = [];
  options: ClientOptions;
  commands: DiscordCommand[];
  listeners: AnyListener[];
  rest: RequestClient;
  componentHandler = new ComponentRegistry<BaseMessageInteractiveComponent>();
  private commandDeployer: DiscordCommandDeployer;
  private entityCache: DiscordEntityCache;
  private eventQueue?: {
    permits: ReturnType<typeof createPermitPool>;
    maxQueueSize: number;
  };
  modalHandler = new ComponentRegistry<Modal>();

  constructor(
    options: ClientOptions,
    handlers: {
      commands?: DiscordCommand[];
      listeners?: AnyListener[];
      components?: BaseMessageInteractiveComponent[];
      modals?: Modal[];
    },
    plugins: RegisteredPlugin[] = [],
  ) {
    if (!options.clientId) {
      throw new Error("Missing Discord application ID");
    }
    if (!options.token) {
      throw new Error("Missing Discord bot token");
    }
    this.options = { ...options };
    this.commands = handlers.commands ?? [];
    this.listeners = handlers.listeners ?? [];
    this.rest = new RequestClient(options.token, options.requestOptions);
    const eventQueue = this.options.eventQueue;
    this.eventQueue = eventQueue
      ? {
          permits: createPermitPool(eventQueue.maxConcurrency ?? 50),
          maxQueueSize: eventQueue.maxQueueSize ?? 10_000,
        }
      : undefined;
    this.entityCache = new DiscordEntityCache(this);
    this.commandDeployer = new DiscordCommandDeployer({
      clientId: this.options.clientId,
      commands: this.commands,
      hashStore: this.options.commandDeployHashStore,
      rest: () => this.rest,
    });
    for (const component of handlers.components ?? []) {
      this.componentHandler.register(component);
    }
    for (const modal of handlers.modals ?? []) {
      this.modalHandler.register(modal);
    }
    for (const plugin of plugins) {
      void plugin.registerClient?.(this);
      this.plugins.push(plugin);
    }
  }

  getPlugin(id: "gateway"): GatewayPluginContract | undefined;
  getPlugin(id: "voice"): VoicePluginContract | undefined;
  getPlugin(id: string): RegisteredPlugin | undefined;
  getPlugin(id: string): RegisteredPlugin | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  async fetchUser(id: string): Promise<User> {
    return await this.entityCache.fetchUser(id);
  }

  async fetchChannel(id: string) {
    return await this.entityCache.fetchChannel(id);
  }

  async fetchGuild(id: string): Promise<Guild> {
    return await this.entityCache.fetchGuild(id);
  }

  async fetchMember(guildId: string, userId: string): Promise<GuildMember> {
    return await this.entityCache.fetchMember(guildId, userId);
  }

  async fetchGuildEmojis<T>(guildId: string, fetcher: () => Promise<T>): Promise<T> {
    return await this.entityCache.fetchGuildEmojis(guildId, fetcher);
  }

  async deployCommands() {
    return await this.commandDeployer.deploy();
  }

  async handleInteraction(rawData: APIInteraction): Promise<void> {
    await dispatchInteraction(this, rawData);
  }

  async dispatchGatewayEvent(type: string, data: unknown): Promise<void> {
    this.entityCache.invalidateForGatewayEvent(type, data);
    const listeners = this.listeners.filter((entry) => entry.type === type);
    if (!this.eventQueue) {
      for (const listener of listeners) {
        await listener.handle(data, this);
      }
      return;
    }
    const queue = this.eventQueue;
    await Promise.all(
      listeners.map(async (listener) => {
        if (queue.permits.pendingCount >= queue.maxQueueSize) {
          throw new Error(
            `Discord event queue is full for ${type}; maxQueueSize=${queue.maxQueueSize}`,
          );
        }
        const listenerName = listener.constructor.name || "AnonymousListener";
        const release = await queue.permits.acquire();
        const startedAt = Date.now();
        try {
          await listener.handle(data, this);
          const durationMs = Date.now() - startedAt;
          if (durationMs < 30_000) {
            return;
          }
          console.warn(
            `[EventQueue] Slow listener detected: ${listenerName} took ${durationMs}ms for event ${type}`,
          );
        } catch (error) {
          console.error(`[EventQueue] Listener ${listenerName} failed for event ${type}:`, error);
        } finally {
          release?.();
        }
      }),
    );
  }
}
