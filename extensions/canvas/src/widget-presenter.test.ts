import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import canvasPlugin from "../index.js";

const commands = ["canvas.present"];
type CanvasNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
const documentUrlPath = "/__openclaw__/canvas/documents/cv_1/index.html";

function node(nodeId: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    nodeId,
    platform: "macos",
    connected: true,
    caps: ["canvas"],
    invocableCommands: commands,
    ...overrides,
  };
}

function presentation(sessionKey?: string) {
  return {
    document: { kind: "html" as const, html: "<p>Status</p>", hostedUrl: documentUrlPath },
    title: "Status",
    context: sessionKey ? { sessionKey } : {},
  };
}

function registeredPresenter(nodes: PluginRuntime["nodes"]) {
  const registerWidgetPresenter = vi.fn<OpenClawPluginApi["registerWidgetPresenter"]>();
  canvasPlugin.register(
    createTestPluginApi({
      runtime: createPluginRuntimeMock({ nodes }),
      registerWidgetPresenter,
    }),
  );
  const presenter = registerWidgetPresenter.mock.calls[0]?.[0];
  if (!presenter) {
    throw new Error("Canvas widget presenter was not registered");
  }
  return presenter;
}

function createNodesRuntime(nodes: CanvasNode[]): PluginRuntime["nodes"] {
  return {
    list: vi.fn(async () => ({ nodes })),
    invoke: vi.fn(async () => ({ ok: true })),
    openDuplex: vi.fn(),
  };
}

describe("Canvas widget presenter", () => {
  it("presents the hosted URL on a versioned macOS node", async () => {
    const runtime = createNodesRuntime([
      node("android-recent", { displayName: "Android", platform: "android", connectedAtMs: 20 }),
      node("mac-local", {
        displayName: "Studio",
        platform: "macOS 26.6.2",
        connectedAtMs: 10,
      }),
    ]);
    const presenter = registeredPresenter(runtime);

    await expect(presenter.present(presentation("agent:main:status"))).resolves.toEqual({
      ok: true,
      value: { kind: "node", nodeId: "mac-local", nodeName: "Studio" },
    });
    expect(runtime.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nodeId: "mac-local",
        command: "canvas.present",
        params: { url: documentUrlPath },
        sessionKey: "agent:main:status",
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it("leaves no stale visible content when atomic presentation fails", async () => {
    const panel = { visible: false, url: undefined as string | undefined };
    const transcript: Array<{ command: string; params: unknown }> = [];
    const runtime = createNodesRuntime([node("mac-panel")]);
    vi.mocked(runtime.invoke).mockImplementation(async ({ command, params }) => {
      transcript.push({ command, params });
      if (command === "canvas.present") {
        if ((params as { url?: unknown } | undefined)?.url === documentUrlPath) {
          throw new Error("presentation rejected");
        }
        panel.visible = true;
        panel.url = "default";
        return { ok: true };
      }
      throw new Error("navigation rejected after presentation");
    });

    const result = await registeredPresenter(runtime).present(presentation());

    expect(result).toEqual({
      ok: false,
      error: { code: "node_error", message: "presentation rejected", nodeId: "mac-panel" },
    });
    expect({ panel, transcript }).toEqual({
      panel: { visible: false, url: undefined },
      transcript: [{ command: "canvas.present", params: { url: documentUrlPath } }],
    });
  });

  it.each([
    node("offline", { connected: false, invocableCommands: undefined, commands }),
    node("linux-panel", { platform: "linux" }),
  ])("rejects unavailable panel $nodeId", async (unavailable) => {
    const runtime = createNodesRuntime([unavailable]);
    const presenter = registeredPresenter(runtime);

    await expect(presenter.availability({})).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });
    await expect(presenter.present(presentation())).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
});
