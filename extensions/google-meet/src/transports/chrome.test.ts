import { runInNewContext } from "node:vm";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { GoogleMeetRuntime } from "../runtime.js";
import { MEET_URL, MEET_URL_EN } from "../test-support/fixtures.test-helpers.js";
import {
  launchChromeMeet,
  leaveChromeMeet,
  readChromeMeetTranscript,
  recoverCurrentMeetTab,
} from "./chrome.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
function unexpected(): never {
  throw new Error("Unexpected runtime operation");
}

type BrowserParams = Record<string, unknown>;
type TestGatewayRequest = (
  method: string,
  params: BrowserParams,
  options?: unknown,
) => Promise<unknown>;

function browserRuntime(
  request: TestGatewayRequest,
  nodes?: Pick<PluginRuntime["nodes"], "list" | "invoke">,
): PluginRuntime {
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    subscribeSessionChanges: unexpected,
    readSessionFacts: unexpected,
    withSessionFacts: unexpected,
    appendAgentMessage: unexpected,
    openPluginPanel: unexpected,
    request: async <T = unknown>(method: string, params?: BrowserParams, options?: unknown) =>
      (await request(method, params ?? {}, options)) as T,
  };
  return { gateway, ...(nodes ? { nodes } : {}) } as PluginRuntime;
}

function gatewayResponses(responses: Record<string, unknown>) {
  return vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const path = String(params.path);
    if (!Object.hasOwn(responses, path)) {
      unexpected();
    }
    return responses[path];
  });
}

function recoveryGateway(
  tabs: Array<{ targetId: string; title: string; url: string }>,
  result = JSON.stringify({ inCall: true, micMuted: true, url: MEET_URL_EN }),
) {
  return gatewayResponses({ "/tabs": { tabs }, "/tabs/focus": { ok: true }, "/act": { result } });
}

function meetTab(targetId: string, url = MEET_URL_EN) {
  return { targetId, title: "Meet", url };
}

function tabInventoryRequest(nodeId: string) {
  return {
    nodeId,
    command: "browser.proxy",
    params: { method: "GET", path: "/tabs", body: undefined, timeoutMs: 5_000 },
    timeoutMs: 10_000,
    scopes: ["operator.admin"],
  };
}

function nodeRuntime(list: PluginRuntime["nodes"]["list"] = unexpected) {
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
    payload: { result: { tabs: [] } },
  }));
  return { runtime: browserRuntime(unexpected, { list, invoke }), invoke };
}

const session = {
  meetingSessionId: "transcript-session",
  meetingUrl: MEET_URL,
  tab: { targetId: "meet-tab", openedByPlugin: false },
};

function recover(
  request: TestGatewayRequest,
  overrides: Partial<Parameters<typeof recoverCurrentMeetTab>[0]> = {},
) {
  return recoverCurrentMeetTab({
    runtime: browserRuntime(request),
    config: resolveGoogleMeetConfig({}),
    mode: "transcribe",
    readOnly: true,
    ...overrides,
  });
}

it("prefers a meeting tab over login with agent captions disabled", async () => {
  const gatewayRequest = recoveryGateway([
    meetTab("google-login-tab", "https://accounts.google.com/signin"),
    meetTab("meet-tab"),
  ]);

  const recovered = await recover(gatewayRequest, {
    fullConfig: { transcripts: { enabled: false } },
    mode: "agent",
  });

  expect(recovered).toMatchObject({ transport: "chrome", found: true, targetId: "meet-tab" });
  expect(Object.hasOwn(recovered, "nodeId")).toBe(false);
  const statusScripts = gatewayRequest.mock.calls
    .filter(([, params]) => params.path === "/act")
    .map(([, params]) => (params.body as { fn?: unknown }).fn);
  expect(statusScripts).toEqual([expect.stringContaining("const captureCaptions = false")]);
});

it("falls back from a tracked target that identifies another meeting", async () => {
  const gatewayRequest = recoveryGateway([
    meetTab("matching-meet-tab"),
    meetTab("tracked-meet-tab", "https://meet.google.com/xyz-abcd-efg?hl=en"),
  ]);

  const recovered = await recover(gatewayRequest, {
    trackedMeetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
    trackedTargetId: "tracked-meet-tab",
    url: "https://meet.google.com/abc-defg-hij?hl=en",
  });

  expect(recovered).toMatchObject({ found: true, targetId: "matching-meet-tab" });
});

it("wraps malformed browser status JSON through tab recovery", async () => {
  const gatewayRequest = recoveryGateway([meetTab("meet-tab")], "{not json");
  await expect(recover(gatewayRequest)).rejects.toThrow(
    "Google Meet browser status JSON is malformed.",
  );
});

it("caps browser gateway timeout padding", async () => {
  const joinTimeoutMs = Number.MAX_SAFE_INTEGER;
  const manualAction = { reason: "meet-admission-required", message: "Waiting for admission" };
  const gatewayRequest = gatewayResponses({
    "/tabs/open": meetTab("meet-tab"),
    "/act": { result: JSON.stringify({ manualAction }) },
  });
  const baseConfig = resolveGoogleMeetConfig({});

  await launchChromeMeet({
    runtime: browserRuntime(gatewayRequest),
    config: {
      ...baseConfig,
      chrome: { ...baseConfig.chrome, joinTimeoutMs, reuseExistingTab: false },
    },
    fullConfig: {},
    meetingSessionId: "session-1",
    mode: "transcribe",
    url: "https://meet.google.com/abc-defg-hij",
    logger,
  });

  expect(gatewayRequest).toHaveBeenCalledWith(
    "browser.request",
    expect.objectContaining({ path: "/tabs/open", timeoutMs: joinTimeoutMs }),
    { timeoutMs: MAX_TIMER_TIMEOUT_MS, scopes: ["operator.admin"] },
  );
});

it("leaves through a pinned node without resolving inventory", async () => {
  const nodeId = "pinned-node";
  const { runtime, invoke } = nodeRuntime();
  const result = await leaveChromeMeet({
    transport: "chrome-node",
    runtime,
    config: resolveGoogleMeetConfig({ chromeNode: { node: "different-configured-node" } }),
    nodeId,
    ...session,
  });

  expect(result).toStrictEqual({ left: true, note: "Meet tab is already closed." });
  expect(invoke.mock.calls).toStrictEqual([[tabInventoryRequest(nodeId)]]);
});

it.each(["chrome", "chrome-node"] as const)(
  "preserves %s route failures before launch-disabled leave",
  async (transport) => {
    const failure = new Error("route unavailable");
    const events: string[] = [];
    const runtime = browserRuntime(unexpected, {
      list: async () => {
        events.push("inventory");
        throw failure;
      },
      invoke: unexpected,
    });
    runtime.gateway.isAvailable = async () => {
      events.push("availability");
      throw failure;
    };
    const leaving = leaveChromeMeet({
      ...(transport === "chrome-node" ? { transport } : {}),
      runtime,
      config: resolveGoogleMeetConfig({ chrome: { launch: false } }),
      ...session,
    });

    if (transport === "chrome-node") {
      await expect(leaving).rejects.toMatchObject({
        message: "Google Meet node inventory unavailable",
        cause: failure,
      });
      expect(events).toStrictEqual(["inventory"]);
    } else {
      await expect(leaving).rejects.toBe(failure);
      expect(events).toStrictEqual(["availability"]);
    }
  },
);

it("re-resolves configured recovery nodes and preserves node response identity", async () => {
  const config = resolveGoogleMeetConfig({ chromeNode: { node: "first-host" } });
  const { runtime, invoke } = nodeRuntime(async () => ({
    nodes: ["first", "second"].map((id) => ({
      nodeId: `${id}-node`,
      displayName: `${id}-host`,
      connected: true,
      commands: ["googlemeet.chrome", "browser.proxy"],
    })),
  }));
  const meet = new GoogleMeetRuntime({ runtime, config, fullConfig: {}, logger });
  const first = await meet.recoverCurrentTab({ transport: "chrome-node" });
  config.chromeNode.node = "second-host";
  const second = await meet.recoverCurrentTab({ transport: "chrome-node" });

  for (const [result, nodeId] of [
    [first, "first-node"],
    [second, "second-node"],
  ] as const) {
    expect(result).toStrictEqual({
      transport: "chrome-node",
      nodeId,
      found: false,
      tab: undefined,
      message: "No existing Meet tab found on the selected Chrome node.",
    });
  }
  expect(invoke.mock.calls).toStrictEqual(
    ["first-node", "second-node"].map((id) => [tabInventoryRequest(id)]),
  );
});

it.each([
  { transport: "chrome" as const, finalize: undefined, joinTimeoutMs: 1_234, timeoutMs: 1_234 },
  { transport: "chrome-node" as const, finalize: true, joinTimeoutMs: 30_000, timeoutMs: 10_000 },
])(
  "reads $transport captions with finalize=$finalize and bounded envelope",
  async ({ transport, finalize, joinTimeoutMs, timeoutMs }) => {
    const source = { epoch: "caption-epoch", revision: "2", finalized: true };
    const committed = {
      at: "2026-09-01T00:00:00.000Z",
      speaker: "First",
      text: "Completed caption",
      source: { ...source, id: "caption-1", ownEcho: false },
    };
    const visible = {
      at: "2026-09-01T00:00:01.000Z",
      speaker: "Second",
      text: "Progressive caption",
      source: { ...source, id: "caption-2", revision: "1", finalized: false },
    };
    const captionState = {
      sessionId: session.meetingSessionId,
      epoch: "caption-epoch",
      droppedLines: 0,
      lines: [committed],
      visible: [visible],
    };
    const evaluate = (params: Record<string, unknown>) => {
      const body = params.body as { fn: string };
      return {
        result: runInNewContext(`(${body.fn})()`, {
          URL,
          location: { href: MEET_URL_EN },
          window: { __openclawMeetCaptions: captionState },
        }),
      };
    };
    const request = vi.fn<TestGatewayRequest>(async (_method, params) => evaluate(params));
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (invocation) => ({
      payload: { result: evaluate(invocation.params as Record<string, unknown>) },
    }));
    const runtime = browserRuntime(request, {
      list: unexpected,
      invoke,
    });
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000_000);
    try {
      // Finalization replaces the source inside the page VM; expect an independent wire value.
      const finalizedVisible = {
        ...visible,
        source: { ...visible.source, revision: "2", finalized: true },
      };
      const expectedLines = finalize === true ? [committed, finalizedVisible] : [committed];
      // Legacy rows remain unattributed, even with ownEcho: false.
      const withProvenance = <T extends { at: string; speaker: string }>(line: T) => ({
        ...line,
        provenance: {
          observer: "google-meet",
          epoch: "caption-epoch",
          self: "unknown",
          observedAt: line.at,
          speaker: line.speaker,
        },
      });
      const expectedSnapshot = {
        droppedLines: 0,
        epoch: "caption-epoch",
        lines: expectedLines.map(withProvenance),
        pendingLines: finalize === true ? [] : [withProvenance(visible)],
      };
      const result = await readChromeMeetTranscript({
        runtime,
        config: resolveGoogleMeetConfig({ chrome: { joinTimeoutMs } }),
        ...(transport === "chrome-node" ? { transport, nodeId: "transcript-node" } : {}),
        ...(finalize === undefined ? {} : { finalize }),
        ...session,
      });
      expect(result).toStrictEqual(expectedSnapshot);
      expect(captionState.lines).toEqual(expectedLines);
      expect(captionState.visible).toEqual(finalize === true ? [] : [visible]);
      const params = {
        method: "POST",
        path: "/act",
        body: { kind: "evaluate", targetId: session.tab.targetId, fn: expect.any(String) },
        timeoutMs,
      };
      const envelope = { timeoutMs: timeoutMs + 5_000, scopes: ["operator.admin"] };
      const nodeRequest = {
        nodeId: "transcript-node",
        command: "browser.proxy",
        params,
        ...envelope,
      };
      expect(request.mock.calls).toStrictEqual(
        transport === "chrome" ? [["browser.request", params, envelope]] : [],
      );
      expect(invoke.mock.calls).toStrictEqual(transport === "chrome-node" ? [[nodeRequest]] : []);
    } finally {
      now.mockRestore();
    }
  },
);
