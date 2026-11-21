import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToText } from "./client-websocket.test-support.js";
import { createBridge } from "./dynamic-tools.test-support.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { createCodexTestModel } from "./test-support.js";

const {
  setupDynamicToolBuildFixture,
  cleanupDynamicToolBuildFixture,
  buildDynamicToolsForTest,
  createParams,
  bindProductionCodexHostCapabilities,
} = await import("./dynamic-tool-build.test-support.js");
let tempDir: string;
let workspaceDir: string;
let params: ReturnType<typeof createParams>;
const hostCapabilityClosers: Array<() => void> = [];
let server: WebSocketServer;
let port: number;
let nodes: unknown[];
const discovery: string[] = [];
beforeEach(async () => {
  nodes = [];
  discovery.length = 0;
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "computer-fixture", ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      const request: { id: string; method: string; params: { maxProtocol: number } } = JSON.parse(
        rawDataToText(data),
      );
      let payload: unknown;
      if (request.method === "connect") {
        payload = {
          type: "hello-ok",
          protocol: request.params.maxProtocol,
          server: { version: "fixture", connId: "computer-fixture" },
          features: { methods: ["node.list", "computer.status"], events: [] },
          snapshot: {},
          policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 60_000 },
        };
      } else {
        discovery.push(request.method);
        payload =
          request.method === "node.list" ? { nodes } : { configured: false, available: false };
      }
      socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
    });
  });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture port");
  }
  port = address.port;
  vi.stubEnv("OPENCLAW_GATEWAY_URL", `ws://127.0.0.1:${port}`);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "computer-fixture-token");
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
});
afterEach(async () => {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});
function buildTools(options: Parameters<typeof buildDynamicToolsForTest>[2]) {
  return buildDynamicToolsForTest(params, workspaceDir, options);
}

it.each(["v2", "v1", "missing", "denied", "scoped", "text"])(
  "serializes the initial paired computer schema through the Codex host: %s",
  async (kind) => {
    const v2Actions = [
      "list_windows",
      "get_window_state",
      "bring_to_front",
      "set_value",
      "get_accessibility_tree",
    ];
    nodes =
      kind === "missing"
        ? []
        : [
            {
              nodeId: "synthetic-windows-node",
              connected: true,
              commands: ["computer.act", "screen.snapshot"],
              ...(kind === "v2"
                ? {
                    computerUse: {
                      contractVersion: 2,
                      provider: { id: "fixture", label: "Fixture", generation: "1" },
                      actions: ["screenshot", ...v2Actions],
                      targets: ["screen", "window"],
                      deliveryModes: ["foreground"],
                      observations: ["image", "accessibility"],
                      features: { recording: false, agentCursor: false, multiDisplay: false },
                    },
                  }
                : {}),
            },
          ];
    params.model = createCodexTestModel("codex", kind === "text" ? ["text"] : ["text", "image"]);
    if (kind === "scoped") {
      params.toolsAllow = ["message"];
    }
    params.config = {
      gateway: { mode: "local", port, auth: { mode: "token", token: "computer-fixture-token" } },
      tools: {
        codeMode: false,
        toolSearch: false,
        ...(kind === "denied" ? { deny: ["computer"] } : {}),
      },
    };
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const tools = await buildTools({ sandbox: null });
    const specs = createBridge(tools, { loading: "direct" }).specs;
    const first = JSON.stringify(
      flattenCodexDynamicToolFunctions(specs).filter((tool) => tool.name === "computer"),
    );
    if (["denied", "scoped", "text"].includes(kind)) {
      expect(tools.some((tool) => tool.name === "computer")).toBe(false);
      expect(discovery).toEqual([]);
      return;
    }
    expect(first).toContain('"computer"');
    for (const action of v2Actions) {
      if (kind === "v2") {
        expect(first).toContain(`"${action}"`);
      } else {
        expect(first).not.toContain(`"${action}"`);
      }
    }
    expect(discovery.toSorted()).toEqual(["computer.status", "node.list"]);
  },
);
