import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  runMeetingBrowserAct,
  type MeetingBrowserRequestCaller,
  type MeetingBrowserRequestParams,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createMeetingBrowserFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import type { GoogleMeetChatSource } from "../google-meet-chat.js";
import { MEET_URL, MEET_URL_EN, meetSession } from "../test-support/fixtures.test-helpers.js";
import { readChromeMeetChat } from "./chrome-chat.js";

const source: GoogleMeetChatSource = {
  kind: "chat",
  id: "spaces/room-1/messages/1789466400000000",
  epoch: "chat-epoch-1",
  revision: "1",
  text: "Could you summarize the decision?",
  ownEcho: false,
  finalized: true,
  historical: false,
  speaker: "Participant",
  at: "10:00 AM",
};
const snapshot = {
  status: "succeeded",
  epoch: source.epoch,
  sources: [source],
  unrecognizedRows: 0,
};
const wire = (value: unknown) => ({ result: JSON.stringify(value) });

function readChatSnapshot(actResult: unknown) {
  return createChatReadFixture("chrome", { actResult }).read();
}

describe("parseGoogleMeetChatRead", () => {
  it("preserves native message identity, metadata, and delivery state", async () => {
    await expect(readChatSnapshot(wire(snapshot))).resolves.toEqual({
      epoch: source.epoch,
      sources: [source],
    });
  });

  it("accepts an unfinished row with empty text and unknown echo ownership", async () => {
    const pending = { ...source, text: "", ownEcho: undefined, finalized: false };
    await expect(readChatSnapshot(wire({ ...snapshot, sources: [pending] }))).resolves.toEqual({
      epoch: source.epoch,
      sources: [{ ...source, text: "", finalized: false, ownEcho: undefined }],
    });
  });

  it("accepts a nonnumeric native ID only as historical context", async () => {
    const historical = {
      ...source,
      id: "spaces/room-1/messages/message-1",
      historical: true,
    };

    await expect(readChatSnapshot(wire({ ...snapshot, sources: [historical] }))).resolves.toEqual({
      epoch: source.epoch,
      sources: [historical],
    });
  });

  it.each<[string, unknown]>([
    ["missing wire envelope", null],
    ["non-string wire result", { result: snapshot }],
    ["malformed JSON", { result: "{not json" }],
    ["non-object JSON", wire([])],
    ["rejected capture", wire({ ...snapshot, status: "rejected" })],
    ["missing source array", wire({ ...snapshot, sources: undefined })],
    ["invalid native ID", wire({ ...snapshot, sources: [{ ...source, id: "dom-row-1" }] })],
    [
      "unsafe fresh native timestamp",
      wire({
        ...snapshot,
        sources: [{ ...source, id: "spaces/room-1/messages/9999999999999999" }],
      }),
    ],
    [
      "fresh nonnumeric native ID",
      wire({ ...snapshot, sources: [{ ...source, id: "spaces/room-1/messages/message-1" }] }),
    ],
    [
      "fresh timestamp shorter than 16 digits",
      wire({ ...snapshot, sources: [{ ...source, id: "spaces/room-1/messages/178946640000000" }] }),
    ],
    [
      "fresh timestamp longer than 16 digits",
      wire({
        ...snapshot,
        sources: [{ ...source, id: "spaces/room-1/messages/17894664000000000" }],
      }),
    ],
    [
      "duplicate native IDs",
      wire({ ...snapshot, sources: [source, { ...source, revision: "2" }] }),
    ],
    ["mismatched epoch", wire({ ...snapshot, sources: [{ ...source, epoch: "old-epoch" }] })],
    ["blank epoch", wire({ ...snapshot, epoch: " " })],
    [
      "missing finalized echo ownership",
      wire({ ...snapshot, sources: [{ ...source, ownEcho: undefined }] }),
    ],
    ["missing finalized text", wire({ ...snapshot, sources: [{ ...source, text: undefined }] })],
    ["blank finalized text", wire({ ...snapshot, sources: [{ ...source, text: " \n " }] })],
  ])("rejects %s with a native snapshot error", async (_name, value) => {
    await expect(readChatSnapshot(value)).rejects.toThrow(
      "Meet returned an invalid native chat snapshot.",
    );
  });
});

function createChatReadFixture(
  transport: "chrome" | "chrome-node" = "chrome-node",
  options?: { actResult: unknown; joinTimeoutMs?: number },
) {
  const browser = createMeetingBrowserFixture({
    url: MEET_URL_EN,
    tabId: "chat-tab",
    title: "Meet",
    tabOpen: true,
  });
  const actResult = options ? options.actResult : wire(snapshot);
  const browserRequest = vi.fn<
    (request: Record<string, unknown>) => ReturnType<MeetingBrowserRequestCaller>
  >(async (request) => (request.path === "/act" ? actResult : browser.browserResult(request)));
  vi.spyOn(browser.runtime.gateway, "request").mockImplementation(async (_method, request) => {
    if (!request) {
      throw new Error("Expected a browser request.");
    }
    return browserRequest(request);
  });
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ params }) => ({
    payload: { result: await browserRequest(params as MeetingBrowserRequestParams) },
  }));
  const list = vi.fn<PluginRuntime["nodes"]["list"]>(async () => ({
    nodes: [{ nodeId: "different-node", connected: true, commands: ["browser.proxy"] }],
  }));
  browser.runtime.nodes = {
    invoke,
    list,
    openDuplex: vi.fn<PluginRuntime["nodes"]["openDuplex"]>(),
  };
  const session = meetSession({
    transport,
    chrome: {
      nodeId: transport === "chrome-node" ? "pinned-node" : undefined,
      browserTab: { targetId: "chat-tab", openedByPlugin: true },
    },
  });
  const read = (assertCurrent?: () => void) =>
    readChromeMeetChat({
      runtime: browser.runtime,
      config: resolveGoogleMeetConfig({
        chrome: { joinTimeoutMs: options?.joinTimeoutMs ?? 1_000 },
      }),
      session,
      assertCurrent,
    });
  return { ...browser, browserRequest, invoke, list, session, read };
}

describe("readChromeMeetChat", () => {
  it.each(["chrome", "chrome-node"] as const)(
    "keeps audio control available during a slow %s chat inventory read",
    async (transport) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const fixture = createChatReadFixture(transport, {
        actResult: wire(snapshot),
        joinTimeoutMs: 30_000,
      });
      fixture.browserRequest.mockImplementationOnce(async (request) => {
        entered.resolve();
        await release.promise;
        return fixture.browserResult(request);
      });
      const read = fixture.read();
      void read.catch(() => undefined);
      try {
        await entered.promise;
        const audioOperation = vi.fn(async () => undefined);
        // The browser-isolated audio transport uses this same five-second lock budget.
        const audio = runMeetingBrowserAct({
          deadline: performance.now() + 5_000,
          targetId: "chat-tab",
          operation: audioOperation,
        }).then(
          () => true,
          () => false,
        );

        await vi.advanceTimersByTimeAsync(5_001);
        expect(audioOperation).toHaveBeenCalledOnce();
        expect(await audio).toBe(true);
        expect(fixture.browserRequest).toHaveBeenCalledTimes(1);

        release.resolve();
        await expect(read).resolves.toEqual({ epoch: source.epoch, sources: [source] });
      } finally {
        release.resolve();
        await read.catch(() => undefined);
        try {
          await runMeetingBrowserAct({
            deadline: performance.now() + 1_000,
            targetId: "chat-tab",
            operation: async () => undefined,
          });
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it.each(["chrome", "chrome-node"] as const)(
    "bounds the optional %s chat evaluation below the audio control budget",
    async (transport) => {
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
      try {
        const fixture = createChatReadFixture(transport, {
          actResult: wire(snapshot),
          joinTimeoutMs: 30_000,
        });

        await expect(fixture.read()).resolves.toEqual({ epoch: source.epoch, sources: [source] });

        expect(fixture.browserRequest.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
          10_000, 1_000,
        ]);
      } finally {
        monotonic.mockRestore();
      }
    },
  );

  it.each(["chrome", "chrome-node"] as const)(
    "keeps a finite monotonic %s budget when the wall clock jumps",
    async (transport) => {
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const fixture = createChatReadFixture(transport);
        fixture.browserRequest.mockImplementationOnce(async (request) => {
          monotonic.mockReturnValue(400);
          wallClock.mockReturnValue(1_800_003_600_000);
          return fixture.browserResult(request);
        });

        await expect(fixture.read()).resolves.toEqual({ epoch: source.epoch, sources: [source] });

        expect(fixture.browserRequest.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
          1_000, 700,
        ]);
      } finally {
        monotonic.mockRestore();
        wallClock.mockRestore();
      }
    },
  );

  it("expires a queued read without evaluating it after the target is released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const holder = runMeetingBrowserAct({
      deadline: performance.now() + 10_000,
      targetId: "chat-tab",
      operation: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const fixture = createChatReadFixture();
    try {
      await entered.promise;
      const settled = vi.fn();
      const read = fixture.read().then(settled, settled);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.browserRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ path: "/tabs" }),
      );

      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringContaining("timed out waiting for browser tab control"),
        }),
      );
    } finally {
      release.resolve();
      try {
        await holder;
        await runMeetingBrowserAct({
          deadline: performance.now() + 1_000,
          targetId: "chat-tab",
          operation: async () => undefined,
        });
      } finally {
        vi.useRealTimers();
      }
    }
    expect(fixture.browserRequest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: "/tabs" }),
    );
  });

  it.each(["chrome", "chrome-node"] as const)(
    "reads the tracked %s tab and returns the native snapshot",
    async (transport) => {
      const fixture = createChatReadFixture(transport);

      await expect(fixture.read()).resolves.toEqual({ epoch: source.epoch, sources: [source] });

      expect(fixture.browserRequest.mock.calls.map(([request]) => request.path)).toEqual([
        "/tabs",
        "/act",
      ]);
      expect(fixture.browserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: "POST",
          body: { kind: "evaluate", targetId: "chat-tab", fn: expect.any(String) },
        }),
      );
      expect(fixture.list).not.toHaveBeenCalled();
      if (transport === "chrome-node") {
        expect(fixture.invoke.mock.calls.map(([request]) => request.nodeId)).toEqual([
          "pinned-node",
          "pinned-node",
        ]);
        expect(fixture.runtime.gateway.isAvailable).not.toHaveBeenCalled();
        expect(fixture.gatewayRequest).not.toHaveBeenCalled();
      } else {
        expect(fixture.invoke).not.toHaveBeenCalled();
        expect(fixture.gatewayRequest).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("rejects a node session without a saved pin before discovery or local fallback", async () => {
    const fixture = createChatReadFixture();
    if (fixture.session.chrome) {
      fixture.session.chrome.nodeId = undefined;
    }

    await expect(fixture.read()).rejects.toThrow("no pinned browser node");

    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.runtime.gateway.isAvailable).not.toHaveBeenCalled();
    expect(fixture.gatewayRequest).not.toHaveBeenCalled();
  });

  it("does not rediscover a node or fall back locally when the saved node fails", async () => {
    const fixture = createChatReadFixture();
    fixture.invoke.mockRejectedValue(new Error("pinned node disconnected"));

    await expect(fixture.read()).rejects.toThrow("pinned node disconnected");

    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.runtime.gateway.isAvailable).not.toHaveBeenCalled();
    expect(fixture.gatewayRequest).not.toHaveBeenCalled();
  });

  it.each<[string, Array<{ targetId: string; url: string }>]>([
    ["missing tab", []],
    ["different meeting", [{ targetId: "chat-tab", url: "https://meet.google.com/xyz-abcd-efg" }]],
    ["same meeting in another tab", [{ targetId: "other-tab", url: MEET_URL }]],
    ["non-Meet origin", [{ targetId: "chat-tab", url: "https://example.com/abc-defg-hij" }]],
    [
      "duplicate tab identities",
      [
        { targetId: "chat-tab", url: MEET_URL },
        { targetId: "chat-tab", url: MEET_URL },
      ],
    ],
  ])("rejects %s before evaluating the page", async (_name, tabs) => {
    const fixture = createChatReadFixture();
    fixture.browserRequest.mockResolvedValueOnce({ tabs });

    await expect(fixture.read()).rejects.toThrow(
      "tracked browser tab no longer shows this meeting",
    );

    expect(fixture.browserRequest).toHaveBeenCalledTimes(1);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.gatewayRequest).not.toHaveBeenCalled();
  });

  it.each(["/tabs", "/act"])(
    "rejects a session replaced while awaiting %s",
    async (changedAfter) => {
      const fixture = createChatReadFixture();
      fixture.browserRequest.mockImplementation(async (request) => {
        await Promise.resolve();
        if (request.path === changedAfter) {
          fixture.session.id = "replacement-session";
        }
        return request.path === "/act" ? wire(snapshot) : fixture.browserResult(request);
      });

      await expect(fixture.read()).rejects.toThrow("tracked meeting changed");

      expect(fixture.browserRequest).toHaveBeenCalledTimes(changedAfter === "/tabs" ? 1 : 2);
    },
  );

  it("rechecks the caller's authority after tab discovery before evaluating", async () => {
    const fixture = createChatReadFixture();
    let active = true;
    fixture.browserRequest.mockImplementationOnce(async (request) => {
      active = false;
      return fixture.browserResult(request);
    });

    await expect(
      fixture.read(() => {
        if (!active) {
          throw new Error("owner released the session");
        }
      }),
    ).rejects.toThrow("owner released the session");

    expect(fixture.browserRequest).toHaveBeenCalledTimes(1);
  });
});
