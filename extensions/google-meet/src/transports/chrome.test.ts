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
import { meetLeaveScript } from "./google-meet-page-scripts.js";
import { forceMeetEnglishUi, isSameMeetUrlForReuse } from "./google-meet-urls.js";

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
    url: MEET_URL,
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
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({ nodeId, scopes: ["operator.admin"] }),
  );
});

it.each(["chrome", "chrome-node"] as const)(
  "preserves %s route failures before launch-disabled leave",
  async (transport) => {
    const failure = new Error("route unavailable");
    const unavailable = async () => {
      throw failure;
    };
    const runtime = browserRuntime(unexpected, {
      list: unavailable,
      invoke: unexpected,
    });
    runtime.gateway.isAvailable = unavailable;
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
    } else {
      await expect(leaving).rejects.toBe(failure);
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

  expect([first, second].map(({ nodeId, transport, found }) => [nodeId, transport, found])).toEqual(
    [
      ["first-node", "chrome-node", false],
      ["second-node", "chrome-node", false],
    ],
  );
  expect(invoke.mock.calls.map(([request]) => request.nodeId)).toEqual([
    "first-node",
    "second-node",
  ]);
});

it.each([
  { transport: "chrome" as const, finalize: undefined, joinTimeoutMs: 1_234, timeoutMs: 1_234 },
  { transport: "chrome-node" as const, finalize: true, joinTimeoutMs: 30_000, timeoutMs: 10_000 },
])(
  "reads $transport captions with finalize=$finalize and bounded envelope",
  async ({ transport, finalize, joinTimeoutMs, timeoutMs }) => {
    const committed = { text: "Completed caption" };
    const visible = { text: "Progressive caption" };
    const captionState = {
      sessionId: session.meetingSessionId,
      epoch: "caption-epoch",
      droppedLines: 0,
      lines: [committed],
      visible: [visible],
    };
    const evaluate = (params: Record<string, unknown>, envelope: unknown) => {
      expect(params).toMatchObject({ timeoutMs, body: { targetId: session.tab.targetId } });
      expect(envelope).toMatchObject({ timeoutMs: timeoutMs + 5_000, scopes: ["operator.admin"] });
      const body = params.body as { fn: string };
      return {
        result: runInNewContext(`(${body.fn})()`, {
          URL,
          location: { href: MEET_URL_EN },
          window: { __openclawMeetCaptions: captionState },
        }),
      };
    };
    const request = vi.fn<TestGatewayRequest>(async (_method, params, envelope) =>
      evaluate(params, envelope),
    );
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (invocation) => {
      expect(invocation).toMatchObject({ nodeId: "transcript-node", command: "browser.proxy" });
      return {
        payload: { result: evaluate(invocation.params as Record<string, unknown>, invocation) },
      };
    });
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000_000);
    try {
      const result = await readChromeMeetTranscript({
        runtime: browserRuntime(request, { list: unexpected, invoke }),
        config: resolveGoogleMeetConfig({ chrome: { joinTimeoutMs } }),
        ...(transport === "chrome-node" ? { transport, nodeId: "transcript-node" } : {}),
        ...(finalize === undefined ? {} : { finalize }),
        ...session,
      });
      expect(result).toStrictEqual({
        droppedLines: 0,
        epoch: "caption-epoch",
        lines: finalize ? [committed, visible] : [committed],
        pendingLines: finalize ? [] : [visible],
      });
      expect(request).toHaveBeenCalledTimes(transport === "chrome" ? 1 : 0);
      expect(invoke).toHaveBeenCalledTimes(transport === "chrome-node" ? 1 : 0);
    } finally {
      now.mockRestore();
    }
  },
);

it("overrides an existing hl and keeps other params", () => {
  expect(forceMeetEnglishUi(`${MEET_URL}?hl=zh-TW&authuser=1`)).toBe(`${MEET_URL_EN}&authuser=1`);
});

it("keeps /new launchable but excludes it from reusable meeting identity", () => {
  const newUrl = "https://meet.google.com/new";
  expect(forceMeetEnglishUi(newUrl)).toBe(`${newUrl}?hl=en`);
  expect(isSameMeetUrlForReuse(newUrl, newUrl)).toBe(false);
});

it("requires the resolved canonical room before leaving a /new tab", () => {
  const context = {
    URL,
    location: { href: `${MEET_URL}?authuser=1` },
    document: { querySelectorAll: () => [] },
  };
  const leave = (url: string) =>
    JSON.parse(runInNewContext(`(${meetLeaveScript(url)})()`, context) as string);
  expect(leave("https://meet.google.com/new")).toEqual({ departed: false });
  expect(leave(MEET_URL)).toEqual({ departed: false, urlMatched: true });
});

it("reports malformed node proxy payloadJSON through the leave route", async () => {
  const { runtime, invoke } = nodeRuntime();
  invoke.mockResolvedValue({ ok: true, payloadJSON: "{not json" });
  await expect(
    leaveChromeMeet({
      runtime,
      config: resolveGoogleMeetConfig({}),
      transport: "chrome-node",
      nodeId: "node-1",
      ...session,
    }),
  ).resolves.toStrictEqual({
    left: false,
    note: "Browser control could not leave the Meet tab: Google Meet browser proxy returned malformed payloadJSON.",
  });
});
