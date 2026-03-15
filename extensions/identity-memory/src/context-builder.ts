/**
 * Builds memory context strings to inject into agent prompts.
 * Combines user profile + relevant episodic memories into a concise block.
 */

import type { IdentityStore } from "./identity-store.js";
import type { MemoryStore } from "./memory-store.js";

export async function buildMemoryContext(params: {
  identityStore: IdentityStore;
  memoryStore: MemoryStore;
  identityId: string;
  currentMessage?: string;
  maxLength: number;
}): Promise<string | undefined> {
  const { identityStore, memoryStore, identityId, currentMessage, maxLength } = params;

  const identity = identityStore.getIdentity(identityId);
  if (!identity) {
    return undefined;
  }

  const profile = memoryStore.getProfile(identityId);
  const parts: string[] = [];

  // Section 1: User profile.
  const profileLines: string[] = [`[User: ${identity.name}]`];
  const platforms = Object.keys(identity.links);
  if (platforms.length > 1) {
    profileLines.push(`Linked platforms: ${platforms.join(", ")}`);
  }
  if (profile.preferences.length > 0) {
    profileLines.push(`Preferences: ${profile.preferences.slice(0, 5).join(", ")}`);
  }
  if (profile.expertise.length > 0) {
    profileLines.push(`Expertise: ${profile.expertise.slice(0, 5).join(", ")}`);
  }
  if (profile.recentTopics.length > 0) {
    profileLines.push(`Recent topics: ${profile.recentTopics.slice(0, 5).join(", ")}`);
  }
  if (profile.interactionCount > 0) {
    profileLines.push(`Interactions: ${profile.interactionCount}`);
  }
  parts.push(profileLines.join("\n"));

  // Section 2: Relevant episodic memories.
  const searchParams: { identityId: string; keyword?: string; limit: number } = {
    identityId,
    limit: 5,
  };

  // Try keyword search first, fall back to recent entries.
  let episodes = await (async () => {
    if (currentMessage) {
      const words = currentMessage
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);
      for (const word of words) {
        const hits = await memoryStore.searchEpisodic({
          identityId,
          keyword: word,
          limit: 5,
        });
        if (hits.length > 0) {
          return hits;
        }
      }
    }
    return memoryStore.searchEpisodic(searchParams);
  })();
  if (episodes.length > 0) {
    const episodeLines = ["[Relevant memories]"];
    for (const ep of episodes) {
      const date = ep.createdAt.slice(0, 10);
      const platform = ep.platform ? ` (${ep.platform})` : "";
      episodeLines.push(`- ${date}${platform}: ${ep.summary}`);
    }
    parts.push(episodeLines.join("\n"));
  }

  const context = parts.join("\n\n");
  if (context.length > maxLength) {
    return context.slice(0, maxLength - 3) + "...";
  }
  return context.length > 0 ? context : undefined;
}
