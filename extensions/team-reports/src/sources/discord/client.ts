import { z } from "zod";
import type { DiscordSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, parseApiBase, readApiResponse, wait } from "../http.js";

const retrySchema = z.object({ retry_after: z.number().finite().nonnegative() });
export const ABORT_LABEL = "Discord collection aborted.";

export class DiscordHttpError extends Error {
  constructor(readonly status: number) {
    super(`Discord request failed (HTTP ${status}); check bot channel permissions.`);
  }
}

export function createClient(
  config: DiscordSourceConfig,
  runtime: SourceRuntime,
  status: SourceStatus,
) {
  const base = parseApiBase(config.apiBaseUrl, "Discord");

  const request = (url: string) =>
    readApiResponse(
      url,
      { Authorization: `Bot ${config.token}`, Accept: "application/json" },
      runtime,
      status,
      ABORT_LABEL,
    );

  return {
    async get(path: string, params?: Record<string, string>): Promise<unknown> {
      const url = new URL(path.replace(/^\//, ""), base);
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, value);
      }
      let retries = 0;
      while (true) {
        checkAbort(runtime.signal, ABORT_LABEL);
        let result: Awaited<ReturnType<typeof request>>;
        try {
          result = await request(url.toString());
        } catch {
          checkAbort(runtime.signal, ABORT_LABEL);
          if (retries >= 2) {
            throw new Error(
              "Discord request failed after retries; check connectivity and API access.",
            );
          }
          await wait(1000 * 2 ** retries++, runtime.signal, ABORT_LABEL);
          continue;
        }
        if (result.status === 429) {
          const retry = retrySchema.safeParse(result.data);
          const headerDelay = Number(result.headers.get("Retry-After"));
          const seconds = retry.success ? retry.data.retry_after : headerDelay;
          await wait(
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000,
            runtime.signal,
            ABORT_LABEL,
          );
          continue;
        }
        if (result.status >= 500 && retries < 2) {
          await wait(1000 * 2 ** retries++, runtime.signal, ABORT_LABEL);
          continue;
        }
        if (result.status < 200 || result.status >= 300) {
          throw new DiscordHttpError(result.status);
        }
        if (result.data === undefined) {
          throw new Error("Discord returned invalid JSON.");
        }
        return result.data;
      }
    },
  };
}
