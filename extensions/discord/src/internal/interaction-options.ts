import type {
  APIApplicationCommandInteractionDataBasicOption,
  APIApplicationCommandInteractionDataOption,
  APIChannel,
  APIInteractionDataResolvedChannel,
} from "discord-api-types/v10";
import { channelFactory, type DiscordChannel, type StructureClient } from "./structures.js";

type OptionsClient = StructureClient & {
  fetchChannel(id: string): Promise<DiscordChannel>;
};

function findOption(
  options: APIApplicationCommandInteractionDataOption[] | undefined,
  matches: (option: APIApplicationCommandInteractionDataOption) => boolean,
): APIApplicationCommandInteractionDataOption | undefined {
  for (const option of options ?? []) {
    if (matches(option)) {
      return option;
    }
    const child = findOption(readChildOptions(option), matches);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function readChildOptions(
  option: APIApplicationCommandInteractionDataOption,
): APIApplicationCommandInteractionDataOption[] | undefined {
  if (!("options" in option) || !Array.isArray(option.options)) {
    return undefined;
  }
  return option.options;
}

export class OptionsHandler {
  constructor(
    private rawOptions: APIApplicationCommandInteractionDataOption[] | undefined,
    private client: OptionsClient,
    private resolvedChannels: Record<string, APIInteractionDataResolvedChannel> | undefined,
  ) {}

  private value(name: string) {
    const option = findOption(this.rawOptions, (entry) => entry.name === name);
    return option && "value" in option ? option.value : undefined;
  }

  getString(name: string): string | null {
    const value = this.value(name);
    return typeof value === "string" ? value : null;
  }

  getNumber(name: string): number | null {
    const value = this.value(name);
    return typeof value === "number" ? value : null;
  }

  getBoolean(name: string): boolean | null {
    const value = this.value(name);
    return typeof value === "boolean" ? value : null;
  }

  async getChannel(name: string, required = false) {
    const value = this.value(name);
    const id = typeof value === "string" ? value : undefined;
    const resolved = id ? this.resolvedChannels?.[id] : undefined;
    if (resolved) {
      return channelFactory(this.client, resolved as APIChannel);
    }
    if (id) {
      return await this.client.fetchChannel(id);
    }
    if (required) {
      throw new Error(`Missing required channel option ${name}`);
    }
    return null;
  }

  getFocused(): APIApplicationCommandInteractionDataBasicOption | undefined {
    return findOption(
      this.rawOptions,
      (option) => "focused" in option && Boolean(option.focused),
    ) as APIApplicationCommandInteractionDataBasicOption | undefined;
  }
}
