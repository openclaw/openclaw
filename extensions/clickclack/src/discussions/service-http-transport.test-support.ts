import { z } from "zod";
import type {
  ClickClackClient,
  ClickClackHttpError,
  createClickClackClient,
} from "../http-client.js";
import type { ClickClackMessage } from "../types.js";

export type DiscussionMessagePage = {
  messages: ClickClackMessage[];
  oldest_seq: number;
  has_older: boolean;
};

type Remote = Pick<
  ClickClackClient,
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
const channelPatch = channelInput.omit({ kind: true }).partial().extend({
  archived: z.boolean().optional(),
});
const pageLimit = z.coerce.number().int().positive();
const transports = new Map<string, typeof fetch>();
let nextTransport = 0;

export function registerDiscussionTestTransport(
  remote: Remote,
  HttpError: typeof ClickClackHttpError,
): string {
  const origin = `https://discussion-${++nextTransport}.fixture.invalid`;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/workspaces") {
        return Response.json({ workspaces: await remote.workspaces() });
      }
      const workspace = /^\/api\/workspaces\/([^/]+)\/channels$/u.exec(url.pathname);
      if (workspace) {
        const workspaceId = decodeURIComponent(workspace[1]!);
        if (request.method === "GET") {
          return Response.json({ channels: await remote.channels(workspaceId) });
        }
        if (request.method === "POST") {
          const body = channelInput.parse(await request.json());
          return Response.json({ channel: await remote.createChannel(workspaceId, body) });
        }
      }
      const channel = /^\/api\/channels\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "PATCH" && channel) {
        const body = channelPatch.parse(await request.json());
        return Response.json({
          channel: await remote.updateChannel(decodeURIComponent(channel[1]!), body),
        });
      }
      const messages = /^\/api\/channels\/([^/]+)\/messages$/u.exec(url.pathname);
      if (request.method === "GET" && messages) {
        const limit = pageLimit.parse(url.searchParams.get("limit"));
        return Response.json(await remote.messagePage(decodeURIComponent(messages[1]!), limit));
      }
      throw new Error(`Unexpected discussion HTTP request: ${request.method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof HttpError) {
        // Let the actual client translate HTTP status/body/headers; transport rejections stay errors.
        const prefix = `ClickClack ${error.status}: `;
        return new Response(error.message.slice(prefix.length), {
          status: error.status,
          headers: error.headers,
        });
      }
      throw error;
    }
  };
  transports.set(origin, transport);
  return origin;
}

export function withDiscussionTestTransport(
  options: Parameters<typeof createClickClackClient>[0],
): Parameters<typeof createClickClackClient>[0] {
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
