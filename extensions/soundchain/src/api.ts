/**
 * SoundChain Agent API Client
 *
 * Wraps the SoundChain Agent REST API at /api/agent/*
 * All read endpoints require NO authentication.
 */

export interface SoundChainConfig {
  apiUrl: string;
  agentName: string;
  agentWallet?: string;
}

async function request(baseUrl: string, path: string, options?: RequestInit): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  return res.json();
}

export function createSoundChainApi(config: SoundChainConfig) {
  const base = config.apiUrl.replace(/\/+$/, "");

  return {
    async searchTracks(query: string, limit = 10): Promise<unknown> {
      return request(base, `/api/agent/tracks?q=${encodeURIComponent(query)}&limit=${limit}`);
    },

    async getRadio(): Promise<unknown> {
      return request(base, "/api/agent/radio");
    },

    async reportPlay(trackId: string, trackTitle: string, scid?: string): Promise<unknown> {
      return request(base, "/api/agent/play", {
        method: "POST",
        body: JSON.stringify({
          track_id: trackId,
          track_title: trackTitle,
          agent_name: config.agentName,
          agent_wallet: config.agentWallet,
          scid,
          source: "openclaw",
        }),
      });
    },

    async getPlayStats(): Promise<unknown> {
      return request(base, "/api/agent/play");
    },

    async getPlatformStats(): Promise<unknown> {
      return request(base, "/api/agent/stats");
    },

    async getTrending(): Promise<unknown> {
      return request(base, "/api/agent/trending");
    },

    async getDiscover(): Promise<unknown> {
      return request(base, "/api/agent/discover");
    },

    async getLeaderboard(): Promise<unknown> {
      return request(base, "/api/agent/leaderboard");
    },
  };
}

export type SoundChainApi = ReturnType<typeof createSoundChainApi>;
