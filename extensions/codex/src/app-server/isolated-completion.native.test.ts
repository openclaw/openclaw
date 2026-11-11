import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { type ClientOptions, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { isolatedParams } from "./isolated-completion.params-test-support.js";
import { resolveManagedCodexClientVersion, setManagedCodexPluginRoot } from "./managed-binary.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  models: [] as string[],
  paths: [] as string[],
}));
vi.unmock("node:child_process");
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
        const target = String(url);
        if (target.startsWith("wss:")) {
          transport.paths.push(target);
        }
        super(target.startsWith("wss:") ? transport.upstream : url, options);
      }
    },
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  createNodeProxyAgent: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: async () => ({ lookup: undefined }),
    fetchWithSsrFGuard: async (params: {
      beforeRequest?: () => void;
      init: RequestInit;
      url: string;
    }) => {
      params.beforeRequest?.();
      const body = JSON.parse(await new Response(params.init.body).text());
      transport.models.push(body.model);
      transport.paths.push(params.url);
      return {
        response: new Response(
          events()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
        release: async () => {},
      };
    },
  };
});
function events() {
  return [
    { type: "response.created", response: { id: "synthetic-native" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "answer",
        content: [{ type: "output_text", text: "NATIVE_BOUNDARY_OK" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "synthetic-native",
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];
}
afterEach(() => {
  vi.unstubAllEnvs();
  setManagedCodexPluginRoot(undefined);
});

it.skipIf(process.platform === "win32")(
  "runs host-prepared API inference through the pinned native CLI and owned relay",
  { timeout: 90_000 },
  async (context) => {
    const dirs = useAutoCleanupTempDirTracker(context.onTestFinished);
    const root = await fs.realpath(dirs.make("codex-isolated-native-"));
    const native = await createCodexNativeTestState(root);
    const catalogPath = path.join(root, "models.json");
    // Offline catalog is synthetic; this proves dispatch, not model entitlement.
    await fs.writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "Synthetic isolated inference model",
            supported_reasoning_levels: [],
            shell_type: "local",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            support_verbosity: false,
            truncation_policy: { mode: "bytes", limit: 10000 },
            experimental_supported_tools: [],
            context_window: 200000,
            model_messages: {
              instructions_template: "You are a test assistant.",
              collaboration_modes: { default: "Synthetic model-owned default policy." },
            },
          },
        ],
      }),
    );
    for (const [key, value] of Object.entries(native.env)) {
      vi.stubEnv(key, value);
    }
    // Managed resolution must select the pinned package, not a newer host Codex.
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, "node"));
    vi.stubEnv("PATH", bin);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("CODEX_API_KEY", undefined);
    vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_BIN", undefined);
    setManagedCodexPluginRoot(path.resolve("extensions/codex"));
    transport.models = [];
    transport.paths = [];
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket, req) => {
      expect(req.headers.authorization).toBe("Bearer synthetic-native-key");
      socket.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const body = JSON.parse(bytes.toString("utf8"));
        transport.models.push(body.model);
        expect(body.tool_choice).toBe("none");
        for (const event of events()) {
          socket.send(JSON.stringify(event));
        }
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture listener");
    }
    transport.upstream = `ws://127.0.0.1:${address.port}`;
    context.onTestFinished(() => {
      for (const socket of wss.clients) {
        socket.terminate();
      }
      wss.close();
      upstream.close();
    });
    const params = isolatedParams({ version: 1, profiles: {} }, "unused", root, native.cwd);
    params.timeoutMs = 45_000;
    params.authorization = {
      owner: "host",
      model: {
        provider: "openai",
        id: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      } as Model,
      auth: {
        mode: "api-key",
        apiKey: "synthetic-native-key",
        profileId: "openai:synthetic",
        source: "fixture",
      },
    };
    const result = await runCodexIsolatedCompletion(params, {
      pluginConfig: {
        appServer: {
          args: ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, "app-server"],
          transport: "stdio",
          homeScope: "agent",
        },
      },
    });
    expect(result.assistant).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      content: [{ type: "text", text: "NATIVE_BOUNDARY_OK" }],
    });
    await expect(resolveManagedCodexClientVersion("package-first")).resolves.toBe(
      CODEX_APP_SERVER_VERSION,
    );
    expect(transport.models).toEqual(["gpt-5.4"]);
    // Native startup may prepare multiple sockets; models records actual inference calls.
    expect(transport.paths.length).toBeGreaterThan(0);
    for (const target of transport.paths) {
      expect(target).toMatch(/^(?:wss|https):\/\/api\.openai\.com\/v1\/responses$/);
    }
  },
);
