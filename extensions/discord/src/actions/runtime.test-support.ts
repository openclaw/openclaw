export type DiscordChannelInfoTest = {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string;
};

export type DiscordSearchResult = Record<string, unknown> & { messages: unknown[] };
