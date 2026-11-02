import { z } from "zod";
import type * as Http from "../http-client.js";
import type { ClickClackMessage } from "../types.js";

export type DiscussionMessagePage = {
  messages: ClickClackMessage[];
  oldest_seq: number;
  has_older: boolean;
};

type Remote = Pick<
  Http.ClickClackClient,
  "workspaces" | "channels" | "createChannel" | "updateChannel"
> & {
  messagePage: (channelId: string, limit: number) => Promise<DiscussionMessagePage>;
};

const channelInput = z.object({
  name: z.string(),
  kind: z.literal("public"),
  external_managed: z.boolean(),
  external_ref: z.string(),
  external_url: z.string().optional(),
  sidebar_section: z.string(),
  display_title: z.string().optional(),
});
const channelPatch = channelInput
  .omit({ kind: true })
  .partial()
  .extend({ archived: z.boolean().optional() });
const routePattern = /^\/api\/(workspaces|channels)(?:\/([^/]+))?(\/channels|\/messages)?$/u;
const pageLimit = z.coerce.number().int().positive();
const transports = new Map<string, typeof fetch>();
let nextTransport = 0;
type ClientOptions = Parameters<typeof Http.createClickClackClient>[0];
type HttpErrorClass = typeof Http.ClickClackHttpError;

export function registerDiscussionTestTransport(remote: Remote, HttpError: HttpErrorClass): string {
  const origin = `https://discussion-${++nextTransport}.fixture.invalid`;
  transports.set(origin, async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    try {
      const [, resource, encodedId, suffix = ""] = routePattern.exec(url.pathname) ?? [];
      const id = decodeURIComponent(encodedId ?? "");
      const routes: Record<string, () => Promise<unknown>> = {
        "GET workspaces": async () => ({ workspaces: await remote.workspaces() }),
        "GET workspaces/id/channels": async () => ({ channels: await remote.channels(id) }),
        "POST workspaces/id/channels": async () => ({
          channel: await remote.createChannel(id, channelInput.parse(await request.json())),
        }),
        "PATCH channels/id": async () => ({
          channel: await remote.updateChannel(id, channelPatch.parse(await request.json())),
        }),
        "GET channels/id/messages": async () =>
          remote.messagePage(id, pageLimit.parse(url.searchParams.get("limit"))),
      };
      const respond = routes[`${request.method} ${resource}${encodedId ? "/id" : ""}${suffix}`];
      if (respond) {
        return Response.json(await respond());
      }
      throw new Error(`Unexpected discussion HTTP request: ${request.method} ${url.pathname}`);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      // The real client translates HTTP errors; transport rejections remain errors.
      const { status, headers } = error;
      return new Response(error.message.slice(`ClickClack ${status}: `.length), {
        status,
        headers,
      });
    }
  });
  return origin;
}

export function withDiscussionTestTransport(options: ClientOptions): ClientOptions {
  const transport = transports.get(options.baseUrl.replace(/\/$/u, ""));
  if (transport) {
    return { ...options, fetch: transport };
  }
  const hostname = new URL(options.baseUrl).hostname;
  if (hostname.endsWith(".fixture.invalid") || hostname.endsWith(".example")) {
    throw new Error(`Unregistered synthetic ClickClack endpoint: ${options.baseUrl}`);
  }
  return options;
}
