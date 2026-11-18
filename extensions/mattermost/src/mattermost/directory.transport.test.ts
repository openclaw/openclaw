import type { RequestListener } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { listMattermostDirectoryGroups } from "./directory.js";

it.each([true, false])(
  "keeps server and policy scopes when the first account allows private network=%s",
  async (firstAllowsPrivateNetwork) => {
    const token = "synthetic-shared-mattermost-token";
    const requests: Array<{ server: string; authorization?: string; path?: string }> = [];
    const handler =
      (server: string): RequestListener =>
      (request, response) => {
        requests.push({ server, authorization: request.headers.authorization, path: request.url });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401).end("{}");
        } else if (request.url === "/api/v4/users/me") {
          response.end(JSON.stringify({ id: "directory-bot" }));
        } else if (request.url === "/api/v4/users/directory-bot/channels?per_page=200") {
          response.end(
            JSON.stringify([{ id: server, type: "O", name: server, display_name: server }]),
          );
        } else {
          response.writeHead(404).end("{}");
        }
      };
    await withServer(handler("a"), async (firstUrl) => {
      await withServer(handler("b"), async (secondUrl) => {
        const account = (baseUrl: string, allowPrivateNetwork = true) => ({
          botToken: token,
          baseUrl,
          network: { dangerouslyAllowPrivateNetwork: allowPrivateNetwork },
        });
        const cfg: OpenClawConfig = {
          channels: {
            mattermost: {
              accounts: {
                a: account(firstUrl, firstAllowsPrivateNetwork),
                "a-copy": account(firstUrl),
                b: account(secondUrl),
              },
            },
          },
        };
        await expect(
          listMattermostDirectoryGroups({ cfg, runtime: createNonExitingRuntimeEnv() }),
        ).resolves.toEqual([
          { kind: "channel", id: "channel:a", name: "a", handle: "a" },
          { kind: "channel", id: "channel:b", name: "b", handle: "b" },
        ]);
        expect(requests).toEqual(
          ["a", "b"].flatMap((server) =>
            ["/api/v4/users/me", "/api/v4/users/directory-bot/channels?per_page=200"].map(
              (path) => ({
                server,
                authorization: `Bearer ${token}`,
                path,
              }),
            ),
          ),
        );
      });
    });
  },
);
