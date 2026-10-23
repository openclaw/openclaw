import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "../session-route.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveMattermostOpaqueTarget } from "./target-resolution.js";

const PUBLIC_CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
const PRIVATE_CHANNEL_ID = "bcdefghijklmnopqrstuvwxyza";
const cases = [
  { id: PUBLIC_CHANNEL_ID, kind: "channel", type: "O" },
  { id: PRIVATE_CHANNEL_ID, kind: "group", type: "P" },
] as const;

describe("Mattermost opaque channel resolution over real HTTP", () => {
  it("preserves real public and private channel identities in outbound thread routes", async () => {
    const requests: Array<{ method: string; path: string; authorization?: string }> = [];

    await withServer(
      (request, response) => {
        const path = request.url ?? "";
        requests.push({
          method: request.method ?? "",
          path,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");

        const channel = cases.find(({ id }) => path === `/api/v4/channels/${id}`);
        response.writeHead(channel ? 200 : 404);
        response.end(
          JSON.stringify(
            channel
              ? { id: channel.id, type: channel.type }
              : {
                  message: path.startsWith("/api/v4/users/")
                    ? "user not found"
                    : "unexpected loopback path",
                },
          ),
        );
      },
      async (baseUrl) => {
        const cfg = {
          channels: {
            mattermost: {
              botToken: "mattermost-loopback-fixture",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;

        for (const { id, kind } of cases) {
          const resolved = await resolveMattermostOpaqueTarget({
            input: id,
            cfg,
            accountId: "default",
          });
          expect(resolved).toEqual({ kind, to: `channel:${id}` });

          const route = resolveMattermostOutboundSessionRoute({
            cfg,
            agentId: "main",
            accountId: "default",
            target: `channel:${id}`,
            resolvedTarget: { to: `channel:${id}`, kind, source: "directory" },
            threadId: "loopback-thread",
          });
          expect(route).toMatchObject({
            peer: { kind, id },
            chatType: kind,
            from: `mattermost:${kind}:${id}`,
            to: `channel:${id}`,
            sessionKey: `agent:main:mattermost:${kind}:${id}:thread:loopback-thread`,
          });
        }

        expect(requests).toEqual(
          cases.flatMap(({ id }) =>
            ["users", "channels"].map((resource) => ({
              method: "GET",
              path: `/api/v4/${resource}/${id}`,
              authorization: "Bearer mattermost-loopback-fixture",
            })),
          ),
        );
      },
    );
  });
});
