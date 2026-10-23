// Prove sanitization through the delivery hook and actual Urbit HTTP pokes.
import { once } from "node:events";
import http from "node:http";
import { text as readBody } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { tlonPlugin } from "./channel.js";

const uploadImageFromUrl = vi.hoisted(() => vi.fn(async () => "https://media.example/image.png"));

vi.mock("./urbit/upload.js", () => ({ uploadImageFromUrl }));

type CapturedPoke = {
  app: string;
  mark: string;
  json: unknown;
};

let server: http.Server;
let baseUrl: string;
const pokes: CapturedPoke[] = [];

beforeEach(async () => {
  pokes.length = 0;
  uploadImageFromUrl.mockClear();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "tlon", plugin: tlonPlugin, source: "test" }]),
  );
  server = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      if (request.method === "POST" && request.url === "/~/login") {
        expect(body).toBe("password=test-code");
        response.writeHead(200, {
          Connection: "close",
          "Set-Cookie": "urbauth-~zod=test-cookie; Path=/; HttpOnly",
        });
        response.end("ok");
        return;
      }
      if (request.method === "PUT" && request.url?.startsWith("/~/channel/")) {
        expect(request.headers.cookie).toBe("urbauth-~zod=test-cookie");
        const payload = JSON.parse(body) as CapturedPoke[];
        expect(payload).toHaveLength(1);
        pokes.push(expectDefined(payload[0], "Urbit HTTP poke"));
        response.writeHead(204, { Connection: "close" }).end();
        return;
      }
      response.writeHead(404, { Connection: "close" }).end();
    })().catch((error: unknown) => {
      response.writeHead(500, { Connection: "close" }).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

it("sanitizes DM, group, and media-caption text before the Urbit poke", async () => {
  const cfg = {
    channels: {
      tlon: {
        ship: "~zod",
        code: "test-code",
        url: baseUrl,
        mediaMaxMb: 1,
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  } as OpenClawConfig;

  const send = (to: string, text: string, mediaUrl?: string) =>
    sendDurableMessageBatch({
      cfg,
      channel: "tlon",
      to,
      payloads: [{ text, ...(mediaUrl ? { mediaUrl } : {}) }],
      skipQueue: true,
    });
  await send(
    "~sampel-palnet",
    "**Done.**\n⚠️ 🛠️ `search private repos (agent)` failed\n\n```text\n⚠️ 🛠️ `documented example (agent)` failed\n```",
  );
  await send(
    "chat/~host-ship/general",
    '## Report\n<tool_call>{"name":"private_exec"}</tool_call>\nAll good.',
  );
  await send(
    "~sampel-palnet",
    "**Caption.**\n⚠️ 🛠️ `read private file (agent)` failed",
    "https://source.example/image.png",
  );
  expect(uploadImageFromUrl).toHaveBeenCalledWith(
    "https://source.example/image.png",
    expect.objectContaining({ shipUrl: baseUrl, shipName: "~zod" }),
    1024 * 1024,
  );

  expect(pokes.map(({ app, mark }) => ({ app, mark }))).toEqual([
    { app: "chat", mark: "chat-dm-action" },
    { app: "channels", mark: "channel-action-1" },
    { app: "chat", mark: "chat-dm-action" },
  ]);

  const expectText = (index: number, included: string[], excluded: string[]) => {
    const json = JSON.stringify(expectDefined(pokes[index], `poke ${index}`).json);
    included.forEach((text) => expect(json).toContain(text));
    excluded.forEach((text) => expect(json).not.toContain(text));
  };
  expectText(0, ['"bold":["Done."]', "documented example (agent)"], ["search private repos"]);
  expectText(1, ['"tag":"h2"', "All good."], ["tool_call", "private_exec"]);
  expectText(
    2,
    ['"bold":["Caption."]', '"src":"https://media.example/image.png"'],
    ["read private file"],
  );
});
