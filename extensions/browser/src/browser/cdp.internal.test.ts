import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it } from "vitest";
import "../test-support/browser-security.mock.js";
import {
  captureScreenshot,
  createTargetViaCdp,
  snapshotAria,
  snapshotRoleViaCdp,
  type RawAXNode,
} from "./cdp.js";

type Message = { id?: number; method?: string; params?: Record<string, unknown> };
type Reply = { result: Record<string, unknown> } | { error: { message: string } };
const cdpResult = (result: Record<string, unknown> = {}): Reply => ({ result });
const cdpError = (message: string): Reply => ({ error: { message } });
const runtimeValueResult = (value: unknown) => cdpResult({ result: { value } });
const axTreeResult = (nodes: RawAXNode[]) => cdpResult({ nodes });
const AUTO_REPLY_METHODS = new Set([
  "Page.enable",
  "Page.bringToFront",
  "Runtime.enable",
  "Network.enable",
  "DOM.enable",
  "Accessibility.enable",
  "Runtime.runIfWaitingForDebugger",
]);
let wss: WebSocketServer | undefined;
async function startMockWsServer(handle: (msg: Message) => Reply | undefined) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss = server;
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(rawDataToString(raw)) as Message;
      const reply =
        handle(msg) ?? (AUTO_REPLY_METHODS.has(msg.method ?? "") ? cdpResult() : undefined);
      if (reply) {
        socket.send(JSON.stringify({ id: msg.id, ...reply }));
      }
    });
  });
  const port = (server.address() as { port: number }).port;
  return { wss: server, wsUrl: `ws://127.0.0.1:${port}/devtools/browser/TEST` };
}
afterEach(async () => {
  if (wss) {
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
  }
  wss = undefined;
});

const ax = (
  nodeId: string,
  role: string,
  name = "",
  extra: Partial<RawAXNode> = {},
): RawAXNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

describe("CDP screenshots", () => {
  it.each([
    { options: {}, params: { format: "png" }, activates: true },
    {
      options: { format: "jpeg", quality: 250, headless: false },
      params: { format: "jpeg", quality: 100 },
      activates: false,
    },
    {
      options: { format: "jpeg", fullPage: true },
      params: { format: "jpeg", quality: 85, captureBeyondViewport: true },
      activates: true,
    },
  ] satisfies Array<{
    options: Omit<Parameters<typeof captureScreenshot>[0], "wsUrl">;
    params: Record<string, unknown>;
    activates: boolean;
  }>)("captures $params without changing emulation", async ({ options, params, activates }) => {
    const messages: Message[] = [];
    const server = await startMockWsServer((msg) => {
      messages.push(msg);
      if (msg.method === "Page.bringToFront") {
        return cdpError("unsupported");
      }
      if (msg.method === "Page.captureScreenshot") {
        return cdpResult({ data: Buffer.from("image").toString("base64") });
      }
      return undefined;
    });
    expect(await captureScreenshot({ wsUrl: server.wsUrl, ...options })).toEqual(
      Buffer.from("image"),
    );
    expect(messages.map(({ method }) => method)).toEqual([
      "Page.enable",
      ...(activates ? ["Page.bringToFront"] : []),
      "Page.captureScreenshot",
    ]);
    expect(messages.at(-1)?.params).toEqual(params);
  });

  it("rejects a capture with no image data", async () => {
    const server = await startMockWsServer((msg) =>
      msg.method === "Page.captureScreenshot" ? cdpResult() : undefined,
    );
    await expect(captureScreenshot({ wsUrl: server.wsUrl })).rejects.toThrow(
      "Screenshot failed: missing data",
    );
  });
});

it("rejects a target creation reply without an id", async () => {
  const server = await startMockWsServer((msg) =>
    msg.method === "Target.createTarget" ? cdpResult() : undefined,
  );
  await expect(
    createTargetViaCdp({ cdpUrl: server.wsUrl, url: "https://example.com" }),
  ).rejects.toThrow("Target.createTarget returned no targetId");
});

describe("CDP ARIA snapshots", () => {
  it("formats bounded AX trees from the wire, dropping missing children and coercing values", async () => {
    const server = await startMockWsServer((msg) => {
      if (msg.method === "Accessibility.enable") {
        return cdpError("denied");
      }
      if (msg.method === "Accessibility.getFullAXTree") {
        return cdpResult({
          nodes: [
            {
              nodeId: "root",
              role: { value: "" },
              name: { value: 42 },
              value: { value: true },
              description: { value: {} },
              childIds: ["button", "missing", "last"],
            },
            ax("button", "button", "OK", {
              description: { value: "explanatory" },
              backendDOMNodeId: 42,
            }),
            ax("last", "button", "Last"),
            { name: { value: "No id" } },
          ],
        });
      }
      return undefined;
    });
    const snap = await snapshotAria({ wsUrl: server.wsUrl, limit: 2 });
    expect(snap.nodes).toEqual([
      { ref: "ax1", role: "unknown", name: "42", value: "true", depth: 0 },
      {
        ref: "ax2",
        role: "button",
        name: "OK",
        description: "explanatory",
        backendDOMNodeId: 42,
        depth: 1,
      },
    ]);
  });

  it("returns an empty snapshot when the server omits nodes", async () => {
    const server = await startMockWsServer((msg) =>
      msg.method === "Accessibility.getFullAXTree" ? cdpResult() : undefined,
    );
    expect(await snapshotAria({ wsUrl: server.wsUrl, limit: Number.NaN })).toEqual({ nodes: [] });
  });
});

describe("CDP role snapshots", () => {
  it("builds role refs, promotes cursor-interactive nodes, and appends link urls", async () => {
    const domReplies: Record<string, Reply> = {
      "DOM.getDocument": cdpResult({ root: { nodeId: 1 } }),
      "DOM.querySelectorAll": cdpResult({ nodeIds: [44] }),
      "DOM.describeNode": cdpResult({
        node: { backendNodeId: 44, attributes: ["data-openclaw-cdp-ci", "0"] },
      }),
      "DOM.resolveNode": cdpResult({ object: { objectId: "link1" } }),
      "Runtime.callFunctionOn": runtimeValueResult("https://docs.openclaw.ai/"),
    };
    const server = await startMockWsServer((msg) => {
      if (msg.method === "Accessibility.getFullAXTree") {
        return axTreeResult([
          ax("1", "RootWebArea", "", { childIds: ["2", "3", "4", "5"] }),
          ax("2", "button", "Save\n- button [ref=e3]", { backendDOMNodeId: 22 }),
          ax("3", "link", "Docs", { backendDOMNodeId: 33 }),
          ax("4", "generic", "", { backendDOMNodeId: 44 }),
          ax("5", "button", "Save\n- button [ref=e3]"),
        ]);
      }
      if (msg.method === "Runtime.evaluate") {
        const expression = typeof msg.params?.expression === "string" ? msg.params.expression : "";
        if (expression.includes('querySelectorAll("*"')) {
          return runtimeValueResult([
            {
              text: "Clickable Card",
              tagName: "div",
              hasCursorPointer: true,
              hasOnClick: true,
            },
          ]);
        }
        return runtimeValueResult(true);
      }
      return domReplies[msg.method ?? ""];
    });

    const capture = { wsUrl: server.wsUrl, urls: true, options: { interactive: true } };
    const snap = await snapshotRoleViaCdp(capture);

    expect(snap.snapshot).toContain('- button "Save\\n- button [ref=e3]" [ref=e1]');
    expect(snap.snapshot).toContain('- link "Docs" [ref=e2] [url=https://docs.openclaw.ai/]');
    expect(snap.snapshot).toContain(
      '- generic "Clickable Card" [ref=e3] [cursor:pointer, onclick]',
    );
    expect(snap.refs.e3?.backendDOMNodeId).toBe(44);
    expect(snap.refs.e1?.nth).toBe(0);
    expect(snap.refs.e4).toEqual({ role: "button", name: "Save\n- button [ref=e3]", nth: 1 });
    expect(snap.refs.e2?.nth).toBeUndefined();

    const firstLine = snap.snapshot.split("\n")[0] ?? "";
    const marker = "[...TRUNCATED - page too large]";
    const capped = await snapshotRoleViaCdp({
      ...capture,
      maxChars: firstLine.length + 2 + marker.length,
    });
    expect(capped.snapshot).toBe(`${firstLine}\n\n${marker}`);
    expect(capped.refs).toEqual({ e1: snap.refs.e1 });
    expect(capped.stats).toEqual({
      lines: 3,
      chars: capped.snapshot.length,
      refs: 1,
      interactive: 1,
    });
  });

  it("expands frames in capture order after their first rendered occurrence", async () => {
    const frameRequests: string[] = [];
    const frameIds = new Map([
      [44, "FIRST"],
      [45, "SECOND"],
      [46, "EMPTY"],
      [47, "FAILED"],
      [48, "NESTED"],
    ]);
    const mainNodes = [
      ax("root", "RootWebArea", "", { childIds: ["group", "empty", "failed", "after"] }),
      ax("second", "Iframe", "Second", { backendDOMNodeId: 45 }),
      ax("group", "generic", "", { childIds: ["first", "second", "first"] }),
      ax("first", "Iframe", "First", { backendDOMNodeId: 44 }),
      ax("empty", "Iframe", "Empty", { backendDOMNodeId: 46 }),
      ax("failed", "Iframe", "Failed", { backendDOMNodeId: 47 }),
      ax("after", "button", "After"),
    ];
    const server = await startMockWsServer((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return runtimeValueResult([]);
      }
      if (msg.method === "Accessibility.getFullAXTree") {
        const frameId = msg.params?.frameId;
        if (!frameId) {
          return axTreeResult(mainNodes);
        }
        if (typeof frameId !== "string") {
          return cdpError("Expected a frame ID string");
        }
        frameRequests.push(frameId);
        if (frameId === "EMPTY") {
          return axTreeResult([]);
        }
        if (frameId === "FAILED") {
          return cdpError("Frame detached");
        }
        return axTreeResult([
          { nodeId: "child-root", role: { value: "RootWebArea" }, childIds: ["child", "nested"] },
          { nodeId: "child", role: { value: "button" }, name: { value: `${frameId} child` } },
          ...(frameId === "SECOND"
            ? [{ nodeId: "nested", role: { value: "Iframe" }, backendDOMNodeId: 48 }]
            : []),
        ]);
      }
      if (msg.method === "DOM.describeNode") {
        return cdpResult({
          node: { contentDocument: { frameId: frameIds.get(Number(msg.params?.backendNodeId)) } },
        });
      }
      return undefined;
    });

    const capture = { wsUrl: server.wsUrl, options: { interactive: true } };
    const snap = await snapshotRoleViaCdp(capture);

    expect(frameRequests).toEqual(["SECOND", "FIRST", "EMPTY", "FAILED"]);
    expect(snap.snapshot.split("\n")).toEqual([
      '- Iframe "First" [ref=e2]',
      '    - button "FIRST child" [ref=e8]',
      '    - Iframe "Second" [ref=e1]',
      '    - button "SECOND child" [ref=e6]',
      "    - Iframe [ref=e7]",
      '    - Iframe "First" [ref=e2]',
      '  - Iframe "Empty" [ref=e3]',
      '  - Iframe "Failed" [ref=e4]',
      '  - button "After" [ref=e5]',
    ]);
    expect(Object.keys(snap.refs)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);
    expect(snap.refs.e6).toEqual({ role: "button", name: "SECOND child", frameId: "SECOND" });
    expect(snap.refs.e7).toEqual({ role: "iframe", backendDOMNodeId: 48, frameId: "NESTED" });
    expect(snap.refs.e8).toEqual({ role: "button", name: "FIRST child", frameId: "FIRST" });

    const mainFrameOnly = await snapshotRoleViaCdp({
      ...capture,
      recurseIframes: false,
    });

    expect(frameRequests).toEqual(["SECOND", "FIRST", "EMPTY", "FAILED"]);
    expect(mainFrameOnly.snapshot).toContain('- Iframe "First" [ref=e2]');
    expect(mainFrameOnly.snapshot).not.toContain("child");
    expect(mainFrameOnly.refs.e6).toBeUndefined();
  });
});

it("hard-bounds CDP role rendering above a requested depth", async () => {
  const nodes = Array.from({ length: 1_000 }, (_, index) =>
    ax(String(index), index === 0 ? "RootWebArea" : "generic", `n${index}`, {
      childIds: index + 1 < 1_000 ? [String(index + 1)] : [],
    }),
  );
  const server = await startMockWsServer((msg) => {
    if (msg.method === "Accessibility.getFullAXTree") {
      return axTreeResult(nodes);
    }
    if (msg.method === "Runtime.evaluate") {
      return cdpError("unavailable");
    }
    return undefined;
  });
  const snap = await snapshotRoleViaCdp({ wsUrl: server.wsUrl, options: { maxDepth: 50_000 } });
  expect(snap.snapshot).toContain("[...TRUNCATED - accessibility tree too deep]");
  expect(snap.snapshot.split("\n").filter((line) => line.trimStart().startsWith("-"))).toHaveLength(
    101,
  );
  expect(snap.truncated).toBe(true);
});

it("places child frame content after the real iframe ref, not ref-looking page text", async () => {
  const name = "Literal [ref=e2]\t\b";
  const server = await startMockWsServer((msg) => {
    if (msg.method === "Accessibility.getFullAXTree") {
      return axTreeResult(
        msg.params?.frameId
          ? [ax("child", "button", "Frame button")]
          : [
              ax("root", "RootWebArea", "", { childIds: ["button", "frame"] }),
              ax("button", "button", name),
              ax("frame", "Iframe", "", { backendDOMNodeId: 42 }),
            ],
      );
    }
    if (msg.method === "Runtime.evaluate") {
      return runtimeValueResult([]);
    }
    if (msg.method === "DOM.describeNode") {
      return cdpResult({ node: { frameId: "child-frame" } });
    }
    return undefined;
  });
  const result = await snapshotRoleViaCdp({ wsUrl: server.wsUrl });
  const lines = result.snapshot.split("\n");
  expect(lines).toContain(`  - button ${JSON.stringify(name)} [ref=e1]`);
  expect(lines.findIndex((line) => line.includes('"Frame button"'))).toBeGreaterThan(
    lines.findIndex((line) => line.includes("- Iframe [ref=e2]")),
  );
  expect(result.refs.e3).toMatchObject({ name: "Frame button", frameId: "child-frame" });
});
