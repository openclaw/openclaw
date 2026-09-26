import type { RequestListener, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

/** Keep Express response ownership until the channel's route can be released. */
export function createMSTeamsWebhookHandler(
  expressApp: RequestListener,
  warn: (message: string) => void,
) {
  const responses = new Map<ServerResponse, Promise<void>>();
  let closing = false;
  let closeTask: Promise<void> | undefined;
  return {
    handler: ((req, res) => {
      if (closing) {
        res.writeHead(503, { "Retry-After": "1" });
        res.end("Service Unavailable");
        return Promise.resolve();
      }
      const response = createDeferred<void>();
      responses.set(res, response.promise);
      const done = () => {
        res.off("finish", done);
        res.off("close", done);
        responses.delete(res);
        response.resolve();
      };
      res.once("finish", done);
      res.once("close", done);
      // No next callback: Express owns finalhandler and asynchronous completion.
      try {
        expressApp(req, res);
      } catch (error) {
        done();
        throw error;
      }
      return response.promise;
    }) satisfies RequestListener,
    close: () => {
      closing = true;
      closeTask ??= (async () => {
        if (responses.size === 0) {
          return;
        }
        try {
          // Preserve the private listener's 30-second request window during stop.
          await withTimeout(
            Promise.all(responses.values()),
            MSTEAMS_REQUEST_TIMEOUT_MS,
            "Microsoft Teams webhook shutdown",
          );
        } catch {
          warn("Microsoft Teams webhook shutdown exceeded 30 seconds; closing active responses");
          for (const response of responses.keys()) {
            response.destroy();
          }
        }
      })();
      return closeTask;
    },
  };
}
