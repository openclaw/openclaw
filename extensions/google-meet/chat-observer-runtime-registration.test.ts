import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as meetingRuntime from "openclaw/plugin-sdk/meeting-runtime";
import type { MeetingParticipationAttempt } from "openclaw/plugin-sdk/meeting-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetConfig, GoogleMeetMode } from "./src/config.js";
import { GoogleMeetChatObserver } from "./src/google-meet-chat.js";
import { GoogleMeetRuntime } from "./src/runtime.js";
import { meetAudioBridge, MEET_URL } from "./src/test-support/fixtures.test-helpers.js";
import {
  createGoogleMeetChatPage,
  nativeGoogleMeetChatMessageId,
} from "./src/test-support/google-meet-chat.test-helpers.js";
import {
  createGoogleMeetBrowserRequestHandlersForTest,
  createGoogleMeetToolGatewayForTest,
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { testing } from "./test-api.js";

const TAB_ID = "observed-chat-tab";
const PINNED_NODE = "observed-chat-node";
const OBSERVATION_TIME_MS = Date.parse("2026-09-15T10:00:00.000Z");
const HISTORY_ID = nativeGoogleMeetChatMessageId(OBSERVATION_TIME_MS - 1);
const FIRST_ID = nativeGoogleMeetChatMessageId(OBSERVATION_TIME_MS + 1);
const SECOND_ID = nativeGoogleMeetChatMessageId(OBSERVATION_TIME_MS + 2);
const QUESTION = "OpenClaw, what is the next step?";
const ANSWER = "Review the proposal.";
const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");
type Consult = ReturnType<
  typeof meetingRuntime.createMeetingRealtimeEngineBindings
>["consultAgent"];
type FixtureOptions = {
  transport: "chrome" | "chrome-node";
  mode: GoogleMeetMode;
  micMuted?: boolean;
  toolPolicy?: GoogleMeetConfig["realtime"]["toolPolicy"];
};

// Registration, the observer, source admission, SQLite claims, and browser scripts
// are real. Only the browser/audio services and agent consultation are simulated.
function setupRegisteredObserver(env: NodeJS.ProcessEnv, options: FixtureOptions) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(OBSERVATION_TIME_MS);
  const participate = vi.spyOn(GoogleMeetRuntime.prototype, "participate");
  const chatStart = vi.spyOn(GoogleMeetChatObserver.prototype, "start");
  const page = createGoogleMeetChatPage();
  const sent: string[] = [];
  page.sendButton.click.mockImplementation(() => {
    sent.push(page.composer.value);
    page.composer.value = "";
    page.sendButton.disabled = true;
  });
  const spoken: string[] = [];
  const hooks: {
    beforeSpeechRefresh?: () => void;
    afterBrowserEvaluation?: () => Promise<void>;
  } = {};
  const speak = vi.fn(
    async (text?: string, assertCurrent?: () => void, refreshCurrent?: () => Promise<void>) => {
      hooks.beforeSpeechRefresh?.();
      await refreshCurrent?.();
      assertCurrent?.();
      if (text) {
        spoken.push(text);
      }
    },
  );
  const audioBridge = { ...meetAudioBridge(), speak };
  const health = { inCall: true, micMuted: options.micMuted ?? true };
  const consult = vi.fn<Consult>().mockResolvedValue({ text: ANSWER });
  const createBindings = meetingRuntime.createMeetingRealtimeEngineBindings;
  const bindings = vi
    .spyOn(meetingRuntime, "createMeetingRealtimeEngineBindings")
    .mockImplementation((params) => ({ ...createBindings(params), consultAgent: consult }));
  const launchResult = (meetingSessionId: string) => {
    page.window["__openclawMeetAudioSession"] = meetingSessionId;
    return {
      launched: true,
      tab: { targetId: TAB_ID, openedByPlugin: true },
      browser: health,
      audioBridge,
    };
  };
  vi.spyOn(chromeTransport, "launchChromeMeet").mockImplementation(async ({ meetingSessionId }) =>
    launchResult(meetingSessionId),
  );
  vi.spyOn(chromeTransport, "launchChromeMeetOnNode").mockImplementation(
    async ({ meetingSessionId }) => ({
      ...launchResult(meetingSessionId),
      nodeId: PINNED_NODE,
      audioBridge: {
        type: "node-command-pair",
        nodeId: PINNED_NODE,
        bridgeId: "observed-chat-bridge",
        providerId: audioBridge.providerId,
        speak,
        getHealth: audioBridge.getHealth,
        stop: audioBridge.stop,
      },
    }),
  );
  const leave = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
    left: true,
    note: "Left the fixture meeting",
  });
  vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
    droppedLines: 0,
    lines: [],
  });
  const recover = vi.spyOn(chromeTransport, "recoverCurrentMeetTab").mockResolvedValue({
    ...(options.transport === "chrome-node"
      ? { transport: options.transport, nodeId: PINNED_NODE }
      : { transport: options.transport }),
    found: true,
    targetId: TAB_ID,
    message: "The fixture meeting is active.",
    browser: health,
  });
  const browserRequest = vi.fn(async (raw: unknown) => {
    const request = requireRecord(raw, "browser request");
    if (request.method === "GET" && request.path === "/tabs") {
      return { tabs: [{ targetId: TAB_ID, url: MEET_URL }] };
    }
    if (request.method === "POST" && request.path === "/act") {
      const body = requireRecord(request.body, "browser action");
      if (body.kind !== "evaluate" || body.targetId !== TAB_ID || typeof body.fn !== "string") {
        throw new Error("Expected evaluation in the tracked Meet tab.");
      }
      const result = await page.evaluate(body.fn);
      await hooks.afterBrowserEvaluation?.();
      return { ok: true, targetId: TAB_ID, result };
    }
    throw new Error(
      `Unexpected browser request: ${String(request.method)} ${String(request.path)}`,
    );
  });
  const harness = setupGoogleMeetPlugin(
    plugin,
    {
      defaultTransport: options.transport,
      defaultMode: options.mode,
      realtime: {
        introMessage: "",
        ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
      },
      chromeNode: { node: "configured-other-node" },
    },
    {
      stateEnv: env,
      fullConfig: { transcripts: { enabled: false } },
      toolContext: { sessionKey: "agent:main:observer-requester" },
      gatewayAvailable: true,
      ...createGoogleMeetBrowserRequestHandlersForTest(PINNED_NODE, browserRequest),
    },
  );
  const invoke = async (method: string, params: unknown) =>
    await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params);
  testing.setCallGatewayFromCliForTests(createGoogleMeetToolGatewayForTest(harness.methods));
  const ledger = createPluginStateKeyedStoreForTests<MeetingParticipationAttempt>("google-meet", {
    namespace: "meeting-participation",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
    env,
  });
  const replies = async () =>
    (await ledger.entries())
      .filter(({ key }) => key.includes(":request:"))
      .map(({ value }) => value);
  const awaitReply = async (index = 0) => {
    // Admit the next serialized reply, then await its real SQLite receipt write.
    await vi.advanceTimersByTimeAsync(0);
    const reply = participate.mock.results[index];
    if (reply?.type !== "return") {
      throw new Error(`Expected automatic chat reply ${index + 1} to be admitted.`);
    }
    return await reply.value;
  };
  const awaitChatStart = async () => {
    const started = chatStart.mock.results[0];
    if (started?.type !== "return") {
      throw new Error("Expected the native chat observer to start.");
    }
    await started.value;
  };
  let sessionId: string | undefined;
  const joinMeeting = async ({ waitForChat = true }: { waitForChat?: boolean } = {}) => {
    const result = await getMeetTool(harness).execute("join-observed-chat", {
      action: "join",
      url: MEET_URL,
    });
    sessionId = result.details.session.id;
    expect(result.details.session).toMatchObject({
      state: "active",
      mode: options.mode,
      chrome: { health: { micMuted: health.micMuted } },
    });
    if (waitForChat) {
      await awaitChatStart();
      // Native provider timestamps must be after the initial observation cutoff
      // and no later than the current page clock when the next poll reads them.
      await vi.advanceTimersByTimeAsync(10);
    }
    return sessionId;
  };
  const cleanup = async () => {
    try {
      if (sessionId) {
        await invoke("googlemeet.leave", { sessionId });
      }
    } finally {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  };
  return {
    page,
    sent,
    spoken,
    hooks,
    speak,
    recover,
    consult,
    bindings,
    harness,
    invoke,
    joinMeeting,
    awaitChatStart,
    replies,
    awaitReply,
    leave,
    cleanup,
  };
}

async function withRegisteredObserver(
  options: FixtureOptions,
  run: (fixture: ReturnType<typeof setupRegisteredObserver>) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "google-meet-chat-observer", applyEnv: false },
    async (state) => {
      const fixture = setupRegisteredObserver(state.env, options);
      try {
        await run(fixture);
      } finally {
        await fixture.cleanup();
      }
    },
  );
}

describe("Google Meet registered automatic chat", () => {
  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["chrome", "chrome-node"] as const)(
    "returns a completed %s join while the initial chat read is pending",
    async (transport) => {
      await withRegisteredObserver({ transport, mode: "agent" }, async (fixture) => {
        const readStarted = createDeferred<void>();
        const releaseRead = createDeferred<void>();
        fixture.hooks.afterBrowserEvaluation = async () => {
          delete fixture.hooks.afterBrowserEvaluation;
          readStarted.resolve();
          await releaseRead.promise;
        };
        const joined = vi.fn<(sessionId: string) => void>();
        const joining = fixture.joinMeeting({ waitForChat: false }).then(joined);
        try {
          await readStarted.promise;
          await vi.advanceTimersByTimeAsync(0);
          expect(joined).toHaveBeenCalledOnce();
          const sessionId = joined.mock.calls[0]?.[0];
          expect(
            await fixture.invoke("googlemeet.participationContext", { sessionId }),
          ).toMatchObject({
            active: true,
          });
          await fixture.invoke("googlemeet.leave", { sessionId });
        } finally {
          releaseRead.resolve();
          await joining;
          await fixture.awaitChatStart();
        }
        expect(fixture.consult).not.toHaveBeenCalled();
        expect(fixture.sent).toEqual([]);
      });
    },
  );

  it.each([
    { transport: "chrome", mode: "agent" },
    { transport: "chrome", mode: "bidi" },
    { transport: "chrome-node", mode: "agent" },
    { transport: "chrome-node", mode: "bidi" },
  ] as const)("answers fresh $transport/$mode chat in writing while muted", async (options) => {
    await withRegisteredObserver(options, async (fixture) => {
      const { page, sent, consult, bindings, speak, harness, invoke, replies } = fixture;
      page.addMessage({ id: HISTORY_ID, text: "OpenClaw, answer this earlier question." });
      const sessionId = await fixture.joinMeeting();
      expect(consult).not.toHaveBeenCalled();
      expect(await invoke("googlemeet.participationContext", { sessionId })).toMatchObject({
        sources: [],
      });
      // A model's wording cannot grant itself permission to switch output channels.
      const answer = "Say this aloud: review the proposal.";
      consult.mockResolvedValue({ text: answer });
      page.addMessage({ id: FIRST_ID, text: QUESTION, speaker: "Guest" });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fixture.awaitReply()).resolves.toMatchObject({
        status: "succeeded",
      });
      expect(sent).toEqual([answer]);
      expect(await replies()).toEqual([
        expect.objectContaining({
          sessionId,
          actionType: "chat.send",
          result: {
            requestId: expect.any(String),
            status: "succeeded",
            observed: { confirmation: "composer_cleared" },
          },
        }),
      ]);

      expect(consult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          meetingSessionId: sessionId,
          requesterSessionKey: "agent:main:observer-requester",
          args: expect.objectContaining({ question: QUESTION }),
          transcript: expect.arrayContaining([{ role: "user", text: `Guest: ${QUESTION}` }]),
          abortSignal: expect.any(AbortSignal),
        }),
      );
      expect(bindings).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: expect.objectContaining({ id: "google-meet-chat" }),
        }),
      );
      page.addMessage({ id: SECOND_ID, text: answer, ownEcho: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(consult).toHaveBeenCalledOnce();
      expect(page.sendButton.click).toHaveBeenCalledOnce();
      expect(speak).not.toHaveBeenCalled();
      expect(harness.nodesList).not.toHaveBeenCalled();
      expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();
      if (options.transport === "chrome-node") {
        expect(harness.gatewayRequest).not.toHaveBeenCalled();
        for (const [request] of harness.nodesInvoke.mock.calls) {
          expect(request).toMatchObject({ nodeId: PINNED_NODE, command: "browser.proxy" });
        }
      } else {
        expect(harness.nodesInvoke).not.toHaveBeenCalled();
      }
    });
  });

  it("answers identical text with distinct native IDs once each", async () => {
    await withRegisteredObserver({ transport: "chrome", mode: "agent" }, async (fixture) => {
      await fixture.joinMeeting();
      fixture.page.addMessage({ id: FIRST_ID, text: QUESTION, groupId: "same-speaker" });
      fixture.page.addMessage({ id: SECOND_ID, text: QUESTION, groupId: "same-speaker" });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fixture.awaitReply(0)).resolves.toMatchObject({ status: "succeeded" });
      await expect(fixture.awaitReply(1)).resolves.toMatchObject({ status: "succeeded" });
      expect(fixture.sent).toEqual([ANSWER, ANSWER]);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fixture.consult).toHaveBeenCalledTimes(2);
      expect(
        fixture.consult.mock.calls.map(
          ([request]) => requireRecord(request.args, "consult args").question,
        ),
      ).toEqual([QUESTION, QUESTION]);
      const attempts = await fixture.replies();
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((attempt) => attempt.sourceId)).size).toBe(2);
      expect(fixture.page.sendButton.click).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores delayed backlog after an empty initial capture but answers a newer request", async () => {
    await withRegisteredObserver({ transport: "chrome", mode: "agent" }, async (fixture) => {
      const sessionId = await fixture.joinMeeting();
      fixture.page.addMessage({ id: HISTORY_ID, text: "OpenClaw, answer this old question." });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(fixture.consult).not.toHaveBeenCalled();
      expect(fixture.sent).toEqual([]);
      expect(await fixture.invoke("googlemeet.participationContext", { sessionId })).toMatchObject({
        sources: [],
      });
      fixture.page.addMessage({ id: FIRST_ID, text: QUESTION });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fixture.awaitReply()).resolves.toMatchObject({ status: "succeeded" });
      expect(fixture.sent).toEqual([ANSWER]);
      expect(await fixture.replies()).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ status: "succeeded" }) }),
      ]);

      expect(fixture.consult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          args: expect.objectContaining({ question: QUESTION }),
        }),
      );
      expect(fixture.page.sendButton.click).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { toolPolicy: "owner", consultedPolicy: "safe-read-only" },
    { toolPolicy: "none", consultedPolicy: "none" },
  ] as const)(
    "limits automatic consultation from $toolPolicy to $consultedPolicy",
    async ({ toolPolicy, consultedPolicy }) => {
      await withRegisteredObserver(
        { transport: "chrome", mode: "agent", toolPolicy },
        async (fixture) => {
          fixture.consult.mockResolvedValue({ text: "NO_REPLY" });
          await fixture.joinMeeting();
          fixture.page.addMessage({ id: FIRST_ID, text: QUESTION });

          await vi.advanceTimersByTimeAsync(1_000);

          expect(fixture.consult).toHaveBeenCalledOnce();
          expect(fixture.bindings).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              config: expect.objectContaining({
                realtime: expect.objectContaining({ toolPolicy: consultedPolicy }),
              }),
            }),
          );
          expect(fixture.page.sendButton.click).not.toHaveBeenCalled();
          expect(fixture.speak).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("aborts a pending original question and sends only the corrected answer", async () => {
    await withRegisteredObserver({ transport: "chrome-node", mode: "bidi" }, async (fixture) => {
      const original = createDeferred<{ text: string }>();
      try {
        fixture.consult
          .mockReturnValueOnce(original.promise)
          .mockResolvedValueOnce({ text: "Begin the rollout." });
        await fixture.joinMeeting();
        fixture.page.addMessage({ id: FIRST_ID, text: QUESTION });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fixture.consult).toHaveBeenCalledOnce();
        const signal = fixture.consult.mock.calls[0]?.[0].abortSignal;
        expect(signal?.aborted).toBe(false);
        const correction = "OpenClaw, what is the next step after approval?";
        fixture.page.editMessage(FIRST_ID, correction);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(signal?.aborted).toBe(true);
        expect(fixture.consult).toHaveBeenCalledTimes(2);
        await expect(fixture.awaitReply()).resolves.toMatchObject({ status: "succeeded" });
        expect(fixture.sent).toEqual(["Begin the rollout."]);
        expect(await fixture.replies()).toEqual([
          expect.objectContaining({ result: expect.objectContaining({ status: "succeeded" }) }),
        ]);

        expect(
          fixture.consult.mock.calls.map(
            ([request]) => requireRecord(request.args, "consult args").question,
          ),
        ).toEqual([QUESTION, correction]);
      } finally {
        original.resolve({ text: "An obsolete answer." });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fixture.sent).toEqual(["Begin the rollout."]);
      expect(fixture.page.sendButton.click).toHaveBeenCalledOnce();
      expect(fixture.speak).not.toHaveBeenCalled();
    });
  });

  it("observes transcribe-mode chat without answering even an explicit voice request", async () => {
    await withRegisteredObserver({ transport: "chrome", mode: "transcribe" }, async (fixture) => {
      const sessionId = await fixture.joinMeeting();
      fixture.page.addMessage({ id: FIRST_ID, text: "OpenClaw, please answer out loud." });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(await fixture.invoke("googlemeet.participationContext", { sessionId })).toMatchObject({
        sources: [expect.objectContaining({ id: FIRST_ID, ownEcho: false })],
      });
      expect(fixture.consult).not.toHaveBeenCalled();
      expect(fixture.page.sendButton.click).not.toHaveBeenCalled();
      expect(fixture.speak).not.toHaveBeenCalled();
      expect(await fixture.replies()).toEqual([]);
    });
  });

  it("revokes a pending answer when the registered leave action ends the session", async () => {
    await withRegisteredObserver({ transport: "chrome-node", mode: "agent" }, async (fixture) => {
      const answer = createDeferred<{ text: string }>();
      fixture.consult.mockReturnValueOnce(answer.promise);
      const sessionId = await fixture.joinMeeting();
      fixture.page.addMessage({ id: FIRST_ID, text: QUESTION });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.consult).toHaveBeenCalledOnce();
      const signal = fixture.consult.mock.calls[0]?.[0].abortSignal;

      await fixture.invoke("googlemeet.leave", { sessionId });
      expect(signal?.aborted).toBe(true);
      answer.resolve({ text: ANSWER });
      await vi.advanceTimersByTimeAsync(3_000);

      expect(fixture.leave).toHaveBeenCalledOnce();
      expect(fixture.page.sendButton.click).not.toHaveBeenCalled();
      expect(fixture.speak).not.toHaveBeenCalled();
      expect(await fixture.replies()).toEqual([]);
    });
  });

  it("routes an explicit voice request to the existing speaker once without native chat", async () => {
    await withRegisteredObserver(
      { transport: "chrome-node", mode: "bidi", micMuted: false },
      async (fixture) => {
        await fixture.joinMeeting();
        fixture.page.addMessage({
          id: FIRST_ID,
          text: "OpenClaw, please reply out loud with the next step.",
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(fixture.awaitReply()).resolves.toMatchObject({ status: "uncertain" });
        expect(fixture.spoken).toEqual([ANSWER]);
        expect(fixture.recover).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              chromeNode: expect.objectContaining({ node: PINNED_NODE }),
            }),
            trackedTargetId: TAB_ID,
            trackedMeetingUrl: MEET_URL,
            readOnly: true,
          }),
        );
        await vi.advanceTimersByTimeAsync(2_000);

        expect(fixture.consult).toHaveBeenCalledOnce();
        expect(fixture.speak).toHaveBeenCalledExactlyOnceWith(
          ANSWER,
          expect.any(Function),
          expect.any(Function),
        );
        expect(fixture.page.sendButton.click).not.toHaveBeenCalled();
        expect(fixture.sent).toEqual([]);
        expect(await fixture.replies()).toEqual([
          expect.objectContaining({
            result: expect.objectContaining({
              status: "uncertain",
              observed: { confirmation: "speech_submitted" },
            }),
          }),
        ]);
      },
    );
  });

  it("does not recover another tab when a source-backed voice admission finds a muted route", async () => {
    await withRegisteredObserver(
      { transport: "chrome-node", mode: "bidi", micMuted: false },
      async (fixture) => {
        const sessionId = await fixture.joinMeeting();
        fixture.recover.mockImplementation(async ({ readOnly }) => ({
          transport: "chrome-node",
          nodeId: PINNED_NODE,
          found: true,
          targetId: readOnly ? TAB_ID : "replacement-tab",
          message: "The original route is muted; another meeting tab is available.",
          browser: { inCall: true, micMuted: readOnly === true },
        }));
        fixture.page.addMessage({
          id: FIRST_ID,
          text: "OpenClaw, please reply out loud with the next step.",
        });

        await vi.advanceTimersByTimeAsync(1_000);
        const result = await fixture.awaitReply();
        expect(result).toMatchObject({ status: "failed" });
        expect(fixture.speak).not.toHaveBeenCalled();
        expect(fixture.spoken).toEqual([]);
        expect(fixture.sent).toEqual([]);
        expect(fixture.recover).toHaveBeenCalledTimes(2);
        for (const [request] of fixture.recover.mock.calls) {
          expect(request).toMatchObject({
            readOnly: true,
            trackedTargetId: TAB_ID,
            trackedMeetingUrl: MEET_URL,
            config: { chromeNode: { node: PINNED_NODE } },
          });
        }
        const status = requireRecord(
          await fixture.invoke("googlemeet.status", { sessionId }),
          "meeting status",
        );
        expect(requireRecord(status.session, "meeting session").chrome).toMatchObject({
          browserTab: { targetId: TAB_ID, openedByPlugin: true },
          nodeId: PINNED_NODE,
        });
      },
    );
  });

  it.each([
    { transport: "chrome", invalidation: "source edit" },
    { transport: "chrome-node", invalidation: "source edit" },
    { transport: "chrome-node", invalidation: "muted microphone" },
    { transport: "chrome-node", invalidation: "missing microphone state" },
    { transport: "chrome-node", invalidation: "missing health" },
    { transport: "chrome-node", invalidation: "missing tab" },
    { transport: "chrome-node", invalidation: "different tab" },
    { transport: "chrome-node", invalidation: "failed recovery" },
  ] as const)(
    "rechecks $invalidation for $transport voice at the speaker boundary without chat fallback",
    async ({ transport, invalidation }) => {
      await withRegisteredObserver(
        { transport, mode: "bidi", micMuted: false },
        async (fixture) => {
          const sessionId = await fixture.joinMeeting();
          fixture.page.addMessage({
            id: FIRST_ID,
            text: "OpenClaw, please reply out loud with the next step.",
          });
          fixture.hooks.beforeSpeechRefresh = () => {
            if (invalidation === "source edit") {
              fixture.page.editMessage(FIRST_ID, "OpenClaw, reply in writing instead.");
              return;
            }
            if (invalidation === "failed recovery") {
              fixture.recover.mockRejectedValue(new Error("Browser health read failed"));
              return;
            }
            // The first readiness check already passed. Only the final read can
            // discover this changed browser state before the speaker writes.
            fixture.recover.mockResolvedValue({
              transport: "chrome-node",
              nodeId: PINNED_NODE,
              found: invalidation !== "missing tab",
              targetId:
                invalidation === "missing tab"
                  ? undefined
                  : invalidation === "different tab"
                    ? "another-meeting-tab"
                    : TAB_ID,
              message: "Fresh browser verification",
              browser:
                invalidation === "missing health" || invalidation === "missing tab"
                  ? undefined
                  : {
                      inCall: true,
                      ...(invalidation === "missing microphone state"
                        ? {}
                        : { micMuted: invalidation === "muted microphone" }),
                    },
            });
          };

          await vi.advanceTimersByTimeAsync(1_000);
          const result = await fixture.awaitReply();
          expect(result).toMatchObject({ status: "uncertain" });
          expect(fixture.speak).toHaveBeenCalledOnce();
          expect(fixture.spoken).toEqual([]);
          expect(fixture.sent).toEqual([]);
          expect(fixture.page.sendButton.click).not.toHaveBeenCalled();
          if (invalidation !== "source edit") {
            const status = requireRecord(
              await fixture.invoke("googlemeet.status", { sessionId }),
              "meeting status",
            );
            const session = requireRecord(status.session, "meeting session");
            const chrome = requireRecord(session.chrome, "meeting browser");
            const health = requireRecord(chrome.health, "meeting health");
            expect(chrome).toMatchObject({
              nodeId: PINNED_NODE,
              browserTab: { targetId: TAB_ID, openedByPlugin: true },
            });
            expect(health).toMatchObject({
              speechReady: false,
              speechBlockedReason:
                invalidation === "muted microphone"
                  ? "meet-microphone-muted"
                  : "browser-unverified",
            });
            expect(health.inCall).toBe(
              invalidation === "muted microphone" || invalidation === "missing microphone state"
                ? true
                : undefined,
            );
          }
          for (const [request] of fixture.recover.mock.calls) {
            expect(request).toMatchObject({
              trackedTargetId: TAB_ID,
              trackedMeetingUrl: MEET_URL,
              readOnly: true,
              ...(transport === "chrome-node"
                ? { config: { chromeNode: { node: PINNED_NODE } } }
                : {}),
            });
          }

          const [attempt] = await fixture.replies();
          if (!attempt?.sourceId) {
            throw new Error("Expected the admitted original voice request in the durable ledger.");
          }
          expect(attempt.result).toEqual(result);
          expect(
            await fixture.invoke("googlemeet.participate", {
              sessionId,
              requestId: attempt.requestId,
              sourceId: attempt.sourceId,
              participationAction: { type: "chat.send", text: ANSWER, output: "voice" },
            }),
          ).toEqual({ ...result, replayed: true });
          await vi.advanceTimersByTimeAsync(2_000);
          expect(fixture.consult).toHaveBeenCalledOnce();
          expect(fixture.speak).toHaveBeenCalledOnce();
          expect(fixture.spoken).toEqual([]);
          expect(fixture.sent).toEqual([]);
        },
      );
    },
  );
});
