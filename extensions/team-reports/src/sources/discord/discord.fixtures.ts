import { expect } from "vitest";
import { MAX_API_RESPONSE_BYTES } from "../../limits.js";
import type { ReportFixtureFetch } from "../../report-network.test-support.js";
import type { DiscordSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";

export const config: DiscordSourceConfig = {
  token: "synthetic-discord-secret",
  guildId: "10",
  channels: [{ id: "20", excerpts: true }],
  excerptMaxChars: 10,
  apiBaseUrl: "https://discord.com/api/v10",
};

export const window = { sinceMs: 1462015105000, untilMs: 1462015107000 };

export function thread(id: string, archivedMs: number, type = 12) {
  return {
    id,
    parent_id: "20",
    name: "discussion",
    type,
    thread_metadata: { archive_timestamp: new Date(archivedMs).toISOString() },
  };
}

export function message(atMs: number, content = "Synthetic discussion", idOffset = 1n) {
  return {
    id: (((BigInt(atMs) - 1420070400000n) << 22n) + idOffset).toString(),
    author: { id: "30", bot: false },
    content,
    timestamp: new Date(atMs).toISOString(),
  };
}

export function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function archives(threads: ReturnType<typeof thread>[], has_more = true) {
  return json({ threads, has_more });
}

export function oversizedPage() {
  return json([message(window.sinceMs + 1, "x".repeat(MAX_API_RESPONSE_BYTES))]);
}

export function expectStatus(status: SourceStatus, warnings: unknown[], skipped = 0) {
  expect(status).toMatchObject({
    ok: warnings.length === 0,
    warnings,
    stats: { privateArchivesSkipped: skipped },
  });
  expect(status.stale === true).toBe(warnings.length > 0);
}

export function runtime(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
): SourceRuntime & {
  fetchImpl: ReportFixtureFetch;
  requests: URL[];
  logs: string[];
} {
  const requests: URL[] = [];
  const logs: string[] = [];
  const log = (text: string) => logs.push(text);
  return {
    requests,
    logs,
    logger: { info: log, warn: log, error: log, debug: log },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push(url);
      const handled = await handler(url, init);
      if (handled) {
        return handled;
      }
      if (url.pathname === "/api/v10/guilds/10/channels") {
        return json([{ id: "20", name: "engineering", type: 0 }]);
      }
      if (url.pathname.endsWith("/threads/active")) {
        return json({ threads: [] });
      }
      if (
        url.pathname.endsWith("/threads/archived/public") ||
        url.pathname.endsWith("/threads/archived/private")
      ) {
        return json({ threads: [], has_more: false });
      }
      if (url.pathname.endsWith("/messages")) {
        return json([]);
      }
      throw new Error("Unexpected synthetic endpoint");
    },
  };
}
