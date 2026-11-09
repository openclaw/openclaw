import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { once } from "node:events";
import { createServer } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadPluginInstanceForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";

it.each([
  ["minimax", false, "\n"],
  ["minimax", true, "\n"],
  ["minimax-portal", true, "\r\n"],
  ["minimax", true, "\r"],
] as const)(
  "loads %s and decodes SSE JSON (multiline: %s, newline: %j)",
  async (providerId, multiline, newline) => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const requests: string[] = [];
    const payload = {
      data: { status: 2, audio: Buffer.from("fictional music").toString("hex") },
      base_resp: { status_code: 0, status_msg: "success" },
    };
    const data = JSON.stringify(payload, null, multiline ? 2 : undefined);
    const body = (
      ": keepalive\n\nevent: message\n" +
      data
        .split("\n")
        .map((line) => "data: " + line)
        .join("\n") +
      "\n\ndata: [DONE]\n\n"
    ).replaceAll("\n", newline);
    const server = createServer((request, response) => {
      requests.push(request.method + " " + request.url);
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    });
    const cfg: OpenClawConfig = {
      plugins: { allow: ["minimax"], entries: { minimax: { enabled: true } } },
      models: {
        providers: {
          [providerId]: {
            baseUrl: "http://127.0.0.1:" + claim.port,
            apiKey: "fictional-test-key",
            request: { allowPrivateNetwork: true },
            models: [],
          },
        },
      },
    };
    let plugin: Awaited<ReturnType<typeof loadPluginInstanceForTest>> | undefined;
    try {
      await once(server.listen(claim.port, "127.0.0.1"), "listening");
      plugin = await loadPluginInstanceForTest({ config: cfg, pluginId: "minimax" });
      const provider = plugin.registry.musicGenerationProviders.find(
        (registration) => registration.provider.id === providerId,
      )?.provider;
      if (!provider) {
        throw new Error("MiniMax music provider was not registered by its plugin");
      }
      const result = await plugin.run(() =>
        provider.generateMusic({
          provider: providerId,
          model: "music-2.6",
          prompt: "fictional soundtrack",
          cfg,
          timeoutMs: 5_000,
        }),
      );
      expect(requests).toEqual(["POST /v1/music_generation"]);
      expect(result.tracks[0]?.buffer).toEqual(Buffer.from("fictional music"));
      expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    } finally {
      try {
        await plugin?.dispose();
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        await claim.release();
      }
    }
  },
);
