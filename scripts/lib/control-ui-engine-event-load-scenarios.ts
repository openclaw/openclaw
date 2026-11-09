import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSHandle, Page } from "playwright";
import type { ChatPaneRuntime } from "../../ui/src/pages/chat/chat-pane-render.ts";
import { getControlUiContextHandle } from "../../ui/src/test-helpers/control-ui-e2e-context.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createEngineTranscript,
  engineProbeInitScript,
  waitForEngineTranscript,
  type EngineScenario,
} from "./control-ui-engine-boot-scenarios.ts";
import { startEngineMeasurement } from "./control-ui-engine-metrics.ts";
import type { EventLoadRow } from "./control-ui-event-load-producer.ts";
import { createEventLoadWire } from "./control-ui-event-load-wire.ts";
import { frames, navigation } from "./control-ui-interaction-navigation.ts";

const foreground = "agent:main:interaction-a";
const background = "agent:main:interaction-b";
const pane = ".chat-pane-cache__pane--active";
const composer = `${pane} .agent-chat__composer-combobox textarea`;

// From the isolated Gateway's synthetic full-row/patch capture. Keep the explicit
// null receipts: their wire cost and client handling exist even on an empty session.
const eventLoadReceiptDefaults: Record<string, unknown> = {
  participants: [],
  participantCount: 0,
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  pinnedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  markedUnreadAt: null,
  agentStatus: null,
  observerDigest: null,
  controlOwnerSessionKey: null,
  deviceFolder: null,
  permissionMode: null,
  communication: null,
  autoLabel: null,
  icon: null,
  color: null,
  channelAvatarUrl: null,
  category: null,
  boardPresentation: null,
  lastAssistantMessage: null,
  thinkingLevel: null,
  cyberAccessProgram: null,
  toolOverrides: null,
  goal: null,
  contextBudgetStatus: null,
  activeModelProvider: null,
  activeModel: null,
  lastRunError: null,
  providerReview: null,
  lastRunId: null,
  hasAutomation: false,
  backgroundProcessCount: null,
  endedAt: null,
  runtimeMs: null,
};
const eventLoadRowDefaults: Record<string, unknown> = {
  visibility: "shared",
  effectiveCommunication: { send: "always", receive: "always" },
  permissionModePending: false,
  spawnDepth: 0,
  createdVia: "operator",
  createdActor: {
    type: "human",
    id: "interaction-viewer",
    identity: { type: "profile", id: "interaction-viewer" },
    label: "Synthetic operator",
  },
  owner: {
    actor: {
      type: "human",
      id: "interaction-viewer",
      identity: { type: "profile", id: "interaction-viewer" },
      label: "Synthetic operator",
    },
  },
  createdAt: 1_800_000_000_000,
  classification: "direct",
  isMain: false,
  isDock: false,
  isBackground: false,
  chatType: "direct",
  archived: false,
  pinned: false,
  sidebarRoot: false,
  unread: false,
  effectiveFastMode: false,
  effectiveFastModeSource: "default",
  fastAutoOnSeconds: 60,
  effectiveResponseUsage: "off",
  effectiveQueueMode: "steer",
  modelOverrideSource: null,
  runtimeSelectionLocked: false,
  agentRuntime: {
    id: "openclaw",
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode: "worker-turn",
    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    devicePlacementSupported: true,
    source: "model",
  },
  totalTokensFresh: false,
  activitySummary: { state: "stale", canEnsure: true },
  hasBoard: false,
  titlePending: false,
  childOwnerSessionKeys: [],
  hasActiveRun: false,
  activeRunIds: [],
  hiddenFromInvolvingMe: false,
  sharingRole: "admin",
  sendDisabledReason: null,
  workspaceReadDisabledReason: null,
  systemSent: true,
  abortedLastRun: false,
  suppressErrorNotice: false,
  totalTokens: 0,
  lifecycleRevision: "00000000-0000-4000-a000-000000000001",
  sessionModelRevision: "synthetic-event-load-model-revision-000000000",
};
const eventLoadReferenceFields =
  "activeRunIds activitySummary agentRuntime archived chatType contextTokens createdActor createdAt createdVia displayName effectiveCommunication effectiveFastMode effectiveFastModeSource effectiveResponseUsage fastAutoOnSeconds hasActiveRun kind label model modelOverrideSource modelProvider owner parentSessionKey permissionModePending pinned runtimeSelectionLocked sessionId sharingRole sidebarRoot spawnDepth titlePending totalTokensFresh unread updatedAt visibility".split(
    " ",
  );

/** Observe native wire delivery; the external producer owns rows, history and subscriptions. */
function installEventLoadProbe() {
  // The bridge exposes completion, not domain state. Capture the same existing
  // host→runtime registration as the cold-load probe, then retire interception.
  const NativeWeakMap = window.WeakMap;
  const paneOwners = new NativeWeakMap<HTMLElement, ChatPaneRuntime>();
  type RunPublication = {
    frame: number | null;
    pendingRunPublication?: boolean;
    framePending?: boolean;
    pendingViews?: Set<unknown>;
    viewTimer?: unknown;
    viewTasks?: unknown;
    cancelViewSlice?: unknown;
    flushingViews?: boolean;
  };
  const runPublications = new NativeWeakMap<object, RunPublication>();
  class RegistrationWeakMap<K extends WeakKey, V> extends NativeWeakMap<K, V> {
    override set(host: K, owner: V): this {
      if (
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        typeof owner === "object" &&
        owner !== null &&
        "element" in owner &&
        owner.element === host &&
        "render" in owner &&
        typeof owner.render === "function"
      ) {
        capturePane(host, owner);
      }
      if (
        typeof host === "object" &&
        host !== null &&
        typeof owner === "object" &&
        owner !== null &&
        "values" in owner &&
        "frame" in owner &&
        (owner.frame === null || typeof owner.frame === "number") &&
        "fields" in owner &&
        Array.isArray(owner.fields) &&
        owner.fields.includes("chatStream") &&
        owner.fields.includes("chatToolMessages") &&
        "batch" in owner &&
        typeof owner.batch === "function" &&
        "publish" in owner &&
        typeof owner.publish === "function"
      ) {
        // SAFETY: This is the existing state→run-publication registration. Optional
        // task fields distinguish the older synchronous and queued prototypes.
        runPublications.set(host, owner as RunPublication);
      }
      return super.set(host, owner);
    }
  }
  function capturePane(host: HTMLElement, owner: object) {
    // SAFETY: capture checks the chat host, owner.element identity, and runtime
    // render method at its existing host→runtime registration boundary.
    paneOwners.set(host, owner as ChatPaneRuntime);
  }
  window.WeakMap = RegistrationWeakMap;
  let active = false;
  let started = 0;
  let loadDeadline = 0;
  let delivered = 0;
  let bytes = 0;
  let backgroundEvents = 0;
  let backgroundReceipts = 0;
  let foregroundEvents = 0;
  let backgroundBytes = 0;
  let mutations = 0;
  let addedRows = 0;
  let typingStartedAt = 0;
  let admitTypingTools = () => {};
  let admitScrollTools = () => {};
  let phaseStart = 0;
  let phaseInput = 0;
  let phaseCommit = 0;
  let phaseKind = "";
  let phaseTarget = "";
  let phaseFrame = 0;
  let phaseBackgroundEvents = 0;
  let phaseBackgroundReceipts = 0;
  let phaseTools = 0;
  let phaseCompletedTools = 0;
  const inputs: number[] = [];
  const delays: number[] = [];
  const taskSpans: number[] = [];
  const receiptAges: Array<{ offsetMs: number; ageMs: number; seq: number; foreground: boolean }> =
    [];
  const applicationAges: typeof receiptAges = [];
  const emissionsBySequence = new Map<number, { emittedAt: number; foreground: boolean }>();
  const dispatchSpans: Array<{ offsetMs: number; durationMs: number; seq: number }> = [];
  const frameGaps: Array<{ offsetMs: number; durationMs: number }> = [];
  const longTasks: Array<{ offsetMs: number; durationMs: number }> = [];
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const collectLongTasks = (entries: PerformanceEntry[]) => {
    if (active) {
      for (const entry of entries) {
        longTasks.push({ offsetMs: entry.startTime - started, durationMs: entry.duration });
      }
    }
  };
  const longTaskObserver = longTasksSupported
    ? new PerformanceObserver((list) => collectLongTasks(list.getEntries()))
    : undefined;
  let turnFrame = 0;
  let previousFrame = 0;
  let foregroundFirstDeliveredAt = 0;
  let foregroundLastDeliveredAt = 0;
  let foregroundLastDispatchFinishedAt = 0;
  let foregroundLastSequence = 0;
  let applicationSettledAt = 0;
  let applicationSettledFrameAt = 0;
  let applicationCompletionPending = false;
  let renderPublicationDrained = () => false;
  let expectedTools = 0;
  let stopResultObserver: (() => void) | undefined;
  const appliedResults: Array<{ id: string; output: string | undefined; received: boolean }> = [];
  let appliedResultsVerified = false;
  const byEvent: Record<string, number> = {};
  const channel = new MessageChannel();
  const pending: number[] = [];
  channel.port1.addEventListener("message", () => {
    const at = pending.shift();
    if (at !== undefined && active) {
      taskSpans.push(performance.now() - at);
    }
  });
  channel.port1.start();
  const OriginalWebSocket = window.WebSocket;
  let wire: WebSocket;
  let socketGeneration = 0;
  let lastSequence = 0;
  let currentSocket: WebSocket | undefined;
  let connectedGeneration = 0;
  const socketCloses: Array<{ code: number; reason: string }> = [];
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      currentSocket = socket;
      const generation = ++socketGeneration;
      socket.addEventListener("close", (event) => {
        if (connectedGeneration === generation) {
          connectedGeneration = 0;
          if (wire !== undefined) {
            wire.send(JSON.stringify({ eventLoadCommand: "disconnect" }));
          }
        }
        if (socketCloses.length < 8) {
          socketCloses.push({ code: event.code, reason: event.reason });
        }
      });
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        if (generation === socketGeneration && connectedGeneration !== generation) {
          const frame = JSON.parse(event.data) as { type?: string; payload?: { type?: string } };
          if (frame.type === "res" && frame.payload?.type === "hello-ok") {
            connectedGeneration = generation;
            queueMicrotask(() =>
              (window as MockGatewayWindow).openclawControlUiE2eGateway!.suspendLatest(),
            );
            if (wire !== undefined) {
              wire.send(JSON.stringify({ eventLoadCommand: "connect" }));
            }
          }
        }
        if (!active) {
          const frame = JSON.parse(event.data) as { type?: string; seq?: number };
          if (frame.type === "event" && frame.seq !== undefined) {
            lastSequence = frame.seq;
          }
          return;
        }
        const name = /"event":"([^"]+)"/u.exec(event.data)?.[1];
        if (!name) {
          return;
        }
        delivered++;
        // Fixtures are ASCII, so UTF-16 length equals their UTF-8 wire bytes.
        bytes += event.data.length;
        if (event.data.includes('"sessionKey":"agent:main:interaction-a"')) {
          foregroundEvents++;
        }
        if (
          event.data.includes('"sessionKey":') &&
          !event.data.includes('"sessionKey":"agent:main:interaction-a"')
        ) {
          backgroundEvents++;
          backgroundBytes += event.data.length;
          if (
            name === "session.message" ||
            (name === "sessions.changed" && event.data.includes('"phase":"message"'))
          ) {
            backgroundReceipts++;
          }
        }
        byEvent[name] = (byEvent[name] ?? 0) + 1;
        pending.push(performance.now());
        channel.port2.postMessage(null);
      });
      return socket;
    },
  });
  const observer = new MutationObserver((records) => {
    if (!active) {
      return;
    }
    mutations += records.length;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(".sidebar-recent-session,.chat-virtual-row")) {
          addedRows++;
        }
      }
    }
  });
  document.addEventListener(
    "input",
    (event) => {
      if (active && event.isTrusted && phaseKind === "typing") {
        phaseCommit = performance.now();
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!active || !event.isTrusted) {
        return;
      }
      phaseInput ||= performance.now();
      if (phaseKind !== "typing") {
        return;
      }
      if (!typingStartedAt) {
        typingStartedAt = performance.now();
        admitTypingTools();
      }
      delays.push(Math.max(0, performance.now() - event.timeStamp));
      requestAnimationFrame(() => inputs.push(performance.now() - event.timeStamp));
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (active && event.isTrusted) {
        phaseInput ||= performance.now();
      }
    },
    true,
  );
  const distribution = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      median: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
      p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : 0,
      max: sorted.at(-1) ?? 0,
    };
  };
  let progress = {
    tools: 0,
    completedTools: 0,
    backgroundReceipts: 0,
    targetBackgroundReceipts: 0,
    latestText: "",
    displayedCheckpoint: 0,
  };
  let settled: (() => void) | undefined;
  Reflect.set(window, "__eventLoad", {
    async connect(url: string) {
      wire = new OriginalWebSocket(url);
      wire.addEventListener("message", (event: MessageEvent<string>) => {
        if (event.data.startsWith('{"eventLoadProgress":')) {
          const frame = JSON.parse(event.data);
          progress = frame.eventLoadProgress;
          if (frame.eventLoadSettled) {
            settled?.();
          }
        } else if (currentSocket) {
          const receivedAt = performance.now();
          const seq = Number(/,"seq":(\d+)\}$/u.exec(event.data)?.[1]);
          const emittedAt = Number(/"eventLoadEmittedAt":([\d.]+)/u.exec(event.data)?.[1]);
          if (active && emittedAt && seq) {
            const isForeground = event.data.includes('"sessionKey":"agent:main:interaction-a"');
            emissionsBySequence.set(seq, { emittedAt, foreground: isForeground });
            receiptAges.push({
              offsetMs: receivedAt - started,
              ageMs: performance.timeOrigin + receivedAt - emittedAt,
              seq,
              foreground: isForeground,
            });
            if (isForeground) {
              foregroundFirstDeliveredAt ||= receivedAt;
              foregroundLastDeliveredAt = receivedAt;
              foregroundLastSequence = seq;
            }
          }
          // Native delivery already owns this task. The production client and receipt
          // probes use EventTarget listeners; avoid the mock probe's timer queue.
          EventTarget.prototype.dispatchEvent.call(
            currentSocket,
            new MessageEvent("message", { data: event.data }),
          );
          if (active && emittedAt && seq) {
            // Synchronous listeners only: Solid's later microtasks are deliberately
            // excluded. Long Tasks and frame gaps include their blocking work.
            dispatchSpans.push({
              offsetMs: receivedAt - started,
              durationMs: performance.now() - receivedAt,
              seq,
            });
            if (seq === foregroundLastSequence) {
              foregroundLastDispatchFinishedAt = performance.now();
            }
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        wire.addEventListener("open", () => resolve(), { once: true });
        wire.addEventListener("error", () => reject(new Error("Event-load wire failed")), {
          once: true,
        });
      });
    },
    start(options: { duration: number; toolCount: number }) {
      if (window.WeakMap === RegistrationWeakMap) {
        window.WeakMap = NativeWeakMap;
      }
      Reflect.deleteProperty(RegistrationWeakMap.prototype, "set");
      const host = document.querySelector<HTMLElement>(".chat-pane-cache__pane--active");
      const owner = host ? paneOwners.get(host) : undefined;
      if (!host || !owner) {
        throw new Error("Event-load application runtime was not captured");
      }
      const runPublication = owner.state ? runPublications.get(owner.state) : undefined;
      if (!runPublication) {
        throw new Error("Event-load run publication owner was not captured");
      }
      renderPublicationDrained = () =>
        runPublication.frame == null &&
        !runPublication.pendingRunPublication &&
        !runPublication.framePending &&
        !runPublication.pendingViews?.size &&
        runPublication.viewTimer == null &&
        runPublication.viewTasks == null &&
        !(Object.hasOwn(runPublication, "cancelViewSlice") && runPublication.cancelViewSlice) &&
        !runPublication.flushingViews;
      expectedTools = options.toolCount;
      const finalIdentity = JSON.stringify([
        "event-load-foreground",
        `event-load-tool-${expectedTools}`,
      ]);
      const appliedFinalResult = () => {
        const state = owner.state;
        const result = state?.toolStreamById.get(finalIdentity);
        return Boolean(
          state &&
          result?.resultReceived === true &&
          result.output === `Tool ${expectedTools} complete.` &&
          state.toolStreamSyncTimer == null &&
          state.chatStreamRenderFrame == null &&
          renderPublicationDrained(),
        );
      };
      const client = owner.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Event-load application client is unavailable");
      }
      // App-level and existing protocol subscribers run first. Observe the
      // applied entry before the owner's bounded live-tool window evicts it.
      stopResultObserver = client.addEventListener((event) => {
        if (active && event.seq !== undefined) {
          const emission = emissionsBySequence.get(event.seq);
          if (emission) {
            const appliedAt = performance.now();
            // This subscriber follows application dispatch, including any socket
            // queue; Solid's later DOM settlement has its separate drain metric.
            applicationAges.push({
              offsetMs: appliedAt - started,
              ageMs: performance.timeOrigin + appliedAt - emission.emittedAt,
              seq: event.seq,
              foreground: emission.foreground,
            });
            emissionsBySequence.delete(event.seq);
          }
        }
        if (event.event !== "agent" || !event.payload || typeof event.payload !== "object") {
          return;
        }
        const payload = event.payload;
        if (
          !("runId" in payload) ||
          payload.runId !== "event-load-foreground" ||
          !("data" in payload)
        ) {
          return;
        }
        const data = payload.data;
        if (
          !data ||
          typeof data !== "object" ||
          !("phase" in data) ||
          data.phase !== "result" ||
          !("toolCallId" in data) ||
          typeof data.toolCallId !== "string"
        ) {
          return;
        }
        const result = owner.state?.toolStreamById.get(
          JSON.stringify([payload.runId, data.toolCallId]),
        );
        appliedResults.push({
          id: data.toolCallId,
          output: result?.output,
          received: result?.resultReceived === true,
        });
      });
      active = true;
      started = performance.now();
      loadDeadline = started + options.duration;
      longTaskObserver?.observe({ type: "longtask" });
      previousFrame = started;
      const sampleFrame = (at: number) => {
        frameGaps.push({ offsetMs: previousFrame - started, durationMs: at - previousFrame });
        previousFrame = at;
        if (
          !applicationSettledAt &&
          !applicationCompletionPending &&
          progress.completedTools === expectedTools &&
          (expectedTools === 0 || appliedFinalResult())
        ) {
          applicationCompletionPending = true;
          void (async () => {
            await Reflect.get(host, "updateComplete");
            const frameAt = await new Promise<number>((resolve) => {
              requestAnimationFrame(resolve);
            });
            if (expectedTools === 0 || appliedFinalResult()) {
              applicationSettledAt = performance.now();
              applicationSettledFrameAt = frameAt;
            }
            applicationCompletionPending = false;
          })();
        }
        turnFrame = requestAnimationFrame(sampleFrame);
      };
      turnFrame = requestAnimationFrame(sampleFrame);
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        subtree: true,
      });
      admitTypingTools = () => wire.send(JSON.stringify({ eventLoadCommand: "typing" }));
      admitScrollTools = () => wire.send(JSON.stringify({ eventLoadCommand: "scroll" }));
    },
    phase(kind: string, target: string) {
      performance.mark(`engine:event-load:${kind}:start`);
      phaseStart = performance.now();
      phaseInput = 0;
      phaseCommit = 0;
      phaseKind = kind;
      phaseTarget = target;
      phaseBackgroundEvents = backgroundEvents;
      phaseBackgroundReceipts = backgroundReceipts;
      phaseTools = progress.tools;
      phaseCompletedTools = progress.completedTools;
      cancelAnimationFrame(phaseFrame);
      const sample = () => {
        const host = document.querySelector(".chat-pane-cache__pane--active");
        const ready =
          phaseKind === "session"
            ? Reflect.get(host ?? {}, "sessionKey") === phaseTarget &&
              Reflect.get(host ?? {}, "transcriptReady") === true
            : phaseKind === "route" && document.querySelector(phaseTarget);
        if (phaseInput && ready) {
          phaseCommit = performance.now();
        } else {
          phaseFrame = requestAnimationFrame(sample);
        }
      };
      if (kind === "session" || kind === "route") {
        phaseFrame = requestAnimationFrame(sample);
      }
    },
    endPhase() {
      performance.mark(`engine:event-load:${phaseKind}:end`);
      cancelAnimationFrame(phaseFrame);
      return {
        actionWallMs: performance.now() - phaseStart,
        applicationMs: phaseCommit && phaseInput ? phaseCommit - phaseInput : undefined,
        backgroundReceived: backgroundEvents - phaseBackgroundEvents,
        backgroundReceiptsAtStart: phaseBackgroundReceipts,
        startedAfterMs: phaseStart - started,
        backgroundReceiptsAtEnd: backgroundReceipts,
        toolsAtStart: phaseTools,
        toolsAtEnd: progress.tools,
        completedToolsAtStart: phaseCompletedTools,
        completedToolsAtEnd: progress.completedTools,
        backgroundActiveAtStart:
          phaseStart < loadDeadline && phaseBackgroundReceipts < progress.targetBackgroundReceipts,
        backgroundActiveAtEnd:
          performance.now() < loadDeadline &&
          progress.backgroundReceipts < progress.targetBackgroundReceipts,
      };
    },
    ready() {
      return {
        tools: progress.tools,
        completedTools: progress.completedTools,
        backgroundEvents,
        foregroundEvents,
        backgroundReceipts,
        targetBackgroundReceipts: progress.targetBackgroundReceipts,
        elapsed: performance.now() - started,
        phaseStartedAt: phaseStart,
        phaseInputAt: phaseInput,
        latestText: progress.latestText,
        displayedCheckpoint: progress.displayedCheckpoint,
        socketGeneration,
        connectedGeneration,
        lastSequence,
        socketCloses,
        applicationDrained: applicationSettledAt !== 0,
      };
    },
    reader() {
      const host = document.querySelector<HTMLElement>(".chat-pane-cache__pane--active");
      const owner = host ? paneOwners.get(host) : undefined;
      const state = owner?.state;
      return {
        followLocked: state?.chatFollowLocked,
        readingHistory: state?.chatReadingHistory,
        appliedResults: appliedResults.length,
        pendingToolRender:
          Boolean(state?.toolStreamSyncTimer || state?.chatStreamRenderFrame) ||
          !renderPublicationDrained(),
      };
    },
    verifyAppliedResults() {
      if (
        appliedResults.length !== expectedTools ||
        appliedResults.some(
          (result, index) =>
            result.id !== `event-load-tool-${index + 1}` ||
            !result.received ||
            result.output !== `Tool ${index + 1} complete.`,
        )
      ) {
        throw new Error(
          `Event-load ordered application results failed (${appliedResults.length}/${expectedTools})`,
        );
      }
      appliedResultsVerified = true;
      return { count: appliedResults.length, ordered: true };
    },
    beginScroll() {
      admitScrollTools();
    },
    settle() {
      return new Promise<void>((resolve) => {
        settled = resolve;
        wire.send(JSON.stringify({ eventLoadCommand: "settle" }));
      });
    },
    finish() {
      const elapsed = performance.now() - started;
      collectLongTasks(longTaskObserver?.takeRecords() ?? []);
      longTaskObserver?.disconnect();
      cancelAnimationFrame(turnFrame);
      stopResultObserver?.();
      const first = foregroundFirstDeliveredAt ? foregroundFirstDeliveredAt - started : 0;
      const last = applicationSettledAt ? applicationSettledAt - started : 0;
      const inTurn = (entry: { offsetMs: number; durationMs: number }) =>
        foregroundFirstDeliveredAt !== 0 &&
        entry.offsetMs < last &&
        entry.offsetMs + entry.durationMs > first;
      // The RAF timestamp bounds frame intervals; callback execution time could
      // otherwise admit the following idle frame into the completed turn.
      const turnGaps = frameGaps.filter(
        (entry) => inTurn(entry) && entry.offsetMs < applicationSettledFrameAt - started,
      );
      const turnTasks = longTasks.filter(inTurn);
      const gapCount = turnGaps.length;
      active = false;
      observer.disconnect();
      return {
        elapsed,
        delivered,
        bytes,
        backgroundEvents,
        backgroundBytes,
        mutations,
        addedRows,
        tools: progress.tools,
        completedTools: progress.completedTools,
        backgroundReceipts,
        targetBackgroundReceipts: progress.targetBackgroundReceipts,
        socketsOpened: socketGeneration,
        socketsClosed: socketCloses.length,
        byEvent,
        inputSampleCount: inputs.length,
        inputs: distribution(inputs),
        delays: distribution(delays),
        delivery: distribution(taskSpans),
        turn: {
          foregroundFirstDeliveredAt: foregroundFirstDeliveredAt
            ? performance.timeOrigin + foregroundFirstDeliveredAt
            : null,
          foregroundLastDeliveredAt: foregroundLastDeliveredAt
            ? performance.timeOrigin + foregroundLastDeliveredAt
            : null,
          foregroundLastSequence,
          foregroundLastDispatchFinishedAt: foregroundLastDispatchFinishedAt
            ? performance.timeOrigin + foregroundLastDispatchFinishedAt
            : null,
          foregroundDeliveryDurationMs: foregroundLastDispatchFinishedAt
            ? foregroundLastDispatchFinishedAt - foregroundFirstDeliveredAt
            : null,
          applicationSettledAt: applicationSettledAt
            ? performance.timeOrigin + applicationSettledAt
            : null,
          applicationDrainMs:
            applicationSettledAt && foregroundFirstDeliveredAt
              ? applicationSettledAt - foregroundFirstDeliveredAt
              : null,
          appliedResultCount: appliedResults.length,
          orderedAppliedResults: appliedResultsVerified,
          frameCount: gapCount,
          framesOver33Fraction: gapCount
            ? turnGaps.filter((gap) => gap.durationMs > 33).length / gapCount
            : null,
          framesOver50Fraction: gapCount
            ? turnGaps.filter((gap) => gap.durationMs > 50).length / gapCount
            : null,
          longTasksSupported,
          longTaskThresholdMs: 50,
          longestLongTaskMs: longTasksSupported
            ? Math.max(0, ...turnTasks.map((task) => task.durationMs))
            : null,
          longTaskCount: longTasksSupported ? turnTasks.length : null,
          receiptAge: distribution(receiptAges.map((sample) => sample.ageMs)),
          applicationAge: distribution(applicationAges.map((sample) => sample.ageMs)),
          applicationAgeSampleCount: applicationAges.length,
          unobservedApplicationEvents: emissionsBySequence.size,
          synchronousDispatch: distribution(dispatchSpans.map((sample) => sample.durationMs)),
          receiptAges,
          applicationAges,
          dispatchSpans,
          frameGaps: turnGaps,
          longTasks: longTasksSupported ? turnTasks : null,
        },
      };
    },
  });
}

async function phase(page: Page, kind: string, action: () => Promise<unknown>, target = "") {
  await page.evaluate(
    ({ kind: phaseKind, target: phaseTarget }) =>
      Reflect.get(window, "__eventLoad").phase(phaseKind, phaseTarget),
    { kind, target },
  );
  await action();
  return page.evaluate(() => Reflect.get(window, "__eventLoad").endPhase());
}

export function createEngineEventLoadScenarios(
  duration = 240_000,
  toolCount = 200,
  inventory = 1_000,
  interactionsOnly = false,
): EngineScenario[] {
  return ([-1, 0, 5, 20, 100, "pageup"] as const).map((entry) => {
    const pageUpProof = entry === "pageup";
    const count = entry === "pageup" ? 0 : entry;
    let wire: Awaited<ReturnType<typeof createEventLoadWire>>;
    let fixtureRows: Parameters<typeof createEventLoadWire>[0];
    let heldRows = 0;
    let toolPreparationMs = 0;
    let roster: ReturnType<typeof createTeamScaleSidebarListOwner>;
    return {
      id: pageUpProof
        ? "event-load-pageup"
        : count === -1
          ? "event-load-unloaded"
          : `event-load-${count}`,
      explicitOnly: true,
      route: controlUiSessionPath(foreground),
      expected: `${Math.max(0, count)} background sessions at one tool/s (two durable-message receipts/s and one status patch/2 s) plus ${count === -1 ? 0 : toolCount} foreground tools preserve typing, scroll, route/session switches and current history.`,
      initScript: `${engineProbeInitScript()};(() => { const __name = (value) => value; (${installEventLoadProbe.toString()})(); })();`,
      settings: { chatShowToolCalls: true, sidebarLiveActivity: true, sidebarAgentsMode: "chip" },
      setup: async (page) => {
        wire = await createEventLoadWire(fixtureRows);
        page.once("close", () => {
          void wire.close();
        });
        await page.exposeBinding("__eventLoadRequest", (_source, method: string, params: unknown) =>
          wire.request(method, params),
        );
      },
      createRequestHandlers: () => ({
        "sessions.list": async (params) => {
          if (!isRecord(params)) {
            throw new Error("Expected sessions.list parameters");
          }
          roster.apply({ upsert: wire?.currentRows() ?? fixtureRows });
          return roster.list(params).result;
        },
      }),
      fixtureOverrides: (_sandbox, base) => {
        const sessions = Array.from({ length: inventory }, (_, index): EventLoadRow => {
          const input = base.sessions[index] ?? {
            ...base.sessions[2]!,
            key: `agent:main:interaction-${index}`,
            sessionId: `interaction-session-${index}`,
            label: `Interaction ${String(index).padStart(4, "0")}`,
            updatedAt: 1_800_000_000_000 - index * 1_000,
          };
          const row = { ...eventLoadRowDefaults, ...input };
          return index === 0 && count >= 0
            ? {
                ...row,
                hasActiveRun: true,
                status: "running",
                activeRunIds: ["event-load-foreground"],
              }
            : index > 0 && index <= count
              ? {
                  ...row,
                  hasActiveRun: true,
                  status: "running",
                  activeRunIds: [`event-load-${row.key}`],
                }
              : row;
        });
        fixtureRows = sessions;
        roster = createTeamScaleSidebarListOwner({
          rows: sessions,
          viewerProfileId: "interaction-viewer",
          now: 1_800_000_000_000,
          defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
          owners: [],
        });
        return {
          sessions,
          webSocketPassthroughPrefixes: ["ws://localhost:"],
          sessionTranscripts: {
            [foreground]: {
              messages: createEngineTranscript(400),
              ...(count >= 0
                ? {
                    inFlightRun: {
                      runId: "event-load-foreground",
                      text: "",
                      startedAt: 1_800_000_400_000,
                    },
                  }
                : {}),
            },
          },
        };
      },
      prepare: async (page) => {
        await waitForEngineTranscript(page, 400);
        const context = await getControlUiContextHandle(page);
        try {
          heldRows = await context.evaluate(async (app, limit) => {
            await app.sessions.refresh({ limit, force: true });
            return app.sessions.state.result?.sessions.length ?? 0;
          }, inventory);
        } finally {
          await context.dispose();
        }
        if (heldRows !== inventory) {
          throw new Error(`Expected ${inventory} held rows, received ${heldRows}`);
        }
        await page.evaluate(async (url) => {
          await Reflect.get(window, "__eventLoad").connect(url);
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          // The external source owns this stream's sequence; retire the mock tick timer.
          gateway.suspendLatest();
          for (const method of [
            "chat.history",
            "chat.startup",
            "sessions.describe",
            "sessions.messages.subscribe",
            "sessions.messages.unsubscribe",
          ]) {
            gateway.setRequestHandler(method, ({ params, respond }) => {
              Reflect.get(window, "__eventLoadRequest")(method, params).then(
                respond,
                (error: unknown) =>
                  respond({
                    __mockError: { code: "EVENT_LOAD_REQUEST_FAILED", message: String(error) },
                  }),
              );
            });
          }
        }, wire.url);
        const initial = await page.evaluate(() => ({
          requests: (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests,
          sequence: Reflect.get(window, "__eventLoad").ready().lastSequence as number,
        }));
        wire.start(
          {
            count: Math.max(0, count),
            duration,
            toolCount: count === -1 ? 0 : toolCount,
            foreground,
            background,
            receiptDefaults: eventLoadReceiptDefaults,
            referenceFields: eventLoadReferenceFields,
          },
          initial.requests,
          initial.sequence,
        );
        const preparationStarted = performance.now();
        if (count >= 0) {
          await page.waitForFunction(() => Reflect.get(window, "__eventLoad").ready().tools > 0);
          const summary = page
            .locator(`${pane} .chat-tool-msg-summary[aria-expanded]`)
            .filter({ hasText: "verify-event-load-1" });
          await summary.waitFor({ state: "visible" });
          if ((await summary.getAttribute("aria-expanded")) === "false") {
            // This is fixture setup; keep the composer's native typing focus.
            await summary.evaluate((element: HTMLElement) => element.click());
          }
          const tool = page
            .locator(`${pane} .chat-tool-msg-collapse`)
            .filter({ hasText: "verify-event-load-1" })
            .first();
          await tool.waitFor({ state: "visible" });
          await tool
            .getByText("Tool 1: live output 2", { exact: false })
            .waitFor({ state: "visible" });
        }
        toolPreparationMs = performance.now() - preparationStarted;
        await page.locator(composer).focus();
      },
      run: async (page) => {
        if (pageUpProof) {
          try {
            return await verifyEventLoadPageUp(page, toolCount);
          } finally {
            wire.finish();
          }
        }
        const requestsBefore = await page.evaluate(
          () => (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests.length,
        );
        await page.evaluate((options) => Reflect.get(window, "__eventLoad").start(options), {
          duration,
          toolCount: count === -1 ? 0 : toolCount,
        });
        wire.startBackground();
        const evidence: Record<string, number | boolean> = {};
        const recordPhase = (
          name: string,
          result: {
            backgroundReceived: number;
            backgroundReceiptsAtStart: number;
            startedAfterMs: number;
            backgroundReceiptsAtEnd: number;
            backgroundActiveAtStart: boolean;
            backgroundActiveAtEnd: boolean;
            toolsAtStart: number;
            toolsAtEnd: number;
            completedToolsAtStart: number;
            completedToolsAtEnd: number;
          },
        ) => {
          evidence[`${name}BackgroundReceived`] = result.backgroundReceived;
          evidence[`${name}BackgroundReceiptsAtStart`] = result.backgroundReceiptsAtStart;
          evidence[`${name}StartedAfterMs`] = result.startedAfterMs;
          evidence[`${name}BackgroundReceiptsAtEnd`] = result.backgroundReceiptsAtEnd;
          evidence[`${name}BackgroundActiveAtStart`] = result.backgroundActiveAtStart;
          evidence[`${name}BackgroundActiveAtEnd`] = result.backgroundActiveAtEnd;
          evidence[`${name}ToolsAtStart`] = result.toolsAtStart;
          evidence[`${name}ToolsAtEnd`] = result.toolsAtEnd;
          evidence[`${name}CompletedToolsAtStart`] = result.completedToolsAtStart;
          evidence[`${name}CompletedToolsAtEnd`] = result.completedToolsAtEnd;
          if (count > 0 && (!result.backgroundActiveAtStart || !result.backgroundActiveAtEnd)) {
            throw new Error(
              `Event load drained before ${name} completed; increase --event-load-duration-ms (started at ${result.backgroundReceiptsAtStart} background receipts)`,
            );
          }
        };
        try {
          const text = "Event load typing preserves every character.";
          const typing = await phase(page, "typing", async () => {
            await page.locator(composer).pressSequentially(text, {
              delay: 35,
              timeout: Math.max(30_000, duration),
            });
            await frames(page);
          });
          evidence.typingActionWallMs = typing.actionWallMs;
          recordPhase("typing", typing);
          if (typing.applicationMs !== undefined) {
            evidence.typingApplicationMs = typing.applicationMs;
          }
          if ((await page.locator(composer).inputValue()) !== text) {
            throw new Error("Event load lost native input");
          }
          const scrolling = await phase(page, "scroll", async () => {
            // Reader input retires queued follow/reveal work before the synthetic sweep.
            await page.locator(`${pane} .chat-thread`).press("ArrowUp");
            const scroll = await page.locator(`${pane} .chat-thread`).evaluate(
              async (thread) => {
                const started = performance.now();
                Reflect.get(window, "__eventLoad").beginScroll();
                const atStart = Reflect.get(window, "__eventLoad").ready();
                if (!atStart.phaseInputAt || document.activeElement !== thread) {
                  throw new Error("Event-load scroll requires native input on the transcript");
                }
                const deliveryMs = started - atStart.phaseStartedAt;
                performance.mark("engine:event-load:scroll:start");
                const frameTimes: number[] = [];
                let blank = 0;
                let firstBlankFrame: string | undefined;
                let firstFrameMs = 0;
                for (let step = 0; step < 90; step++) {
                  thread.scrollTop = (thread.scrollHeight - thread.clientHeight) * (1 - step / 89);
                  await new Promise<void>((resolve) => {
                    requestAnimationFrame((at) => {
                      if (frameTimes.length === 0) {
                        firstFrameMs = performance.now() - started;
                      }
                      frameTimes.push(at);
                      resolve();
                    });
                  });
                  const viewport = thread.getBoundingClientRect();
                  const top = viewport.top + thread.clientTop;
                  const left = viewport.left + thread.clientLeft;
                  const bottom = top + thread.clientHeight;
                  const right = left + thread.clientWidth;
                  const visibleRow = [...thread.querySelectorAll(".chat-virtual-row")].some(
                    (row) => {
                      const bounds = row.getBoundingClientRect();
                      return (
                        bounds.bottom > top &&
                        bounds.top < bottom &&
                        bounds.right > left &&
                        bounds.left < right
                      );
                    },
                  );
                  if (!visibleRow) {
                    blank++;
                    if (firstBlankFrame === undefined) {
                      const capture = () => {
                        const bounds = thread.getBoundingClientRect();
                        return {
                          step,
                          elapsedMs: performance.now() - started,
                          scrollTop: thread.scrollTop,
                          scrollHeight: thread.scrollHeight,
                          innerHeight:
                            thread.querySelector<HTMLElement>(".chat-thread-inner")?.style.height,
                          blockTop:
                            thread.querySelector<HTMLElement>(".chat-virtual-block")?.style.top,
                          viewport: {
                            top: bounds.top + thread.clientTop,
                            bottom: bounds.top + thread.clientTop + thread.clientHeight,
                            left: bounds.left + thread.clientLeft,
                            right: bounds.left + thread.clientLeft + thread.clientWidth,
                          },
                          rows: [...thread.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
                            (row) => {
                              const rect = row.getBoundingClientRect();
                              return {
                                index: row.dataset.index,
                                key: row.dataset.virtualRowKey,
                                prepared: row.dataset.preparedRow,
                                preparing: row.dataset.preparingRow,
                                streaming: row.dataset.streamingRow,
                                top: rect.top,
                                bottom: rect.bottom,
                                left: rect.left,
                                right: rect.right,
                                children: row.childElementCount,
                              };
                            },
                          ),
                        };
                      };
                      const before = capture();
                      // Keep the target fixed while the current render opportunity finishes.
                      // This diagnostic runs only in an observation already marked as failed.
                      await new Promise<void>((resolve) => {
                        setTimeout(resolve, 0);
                      });
                      firstBlankFrame = JSON.stringify({ before, afterRenderTask: capture() });
                    }
                  }
                }
                const observedMs = performance.now() - started;
                performance.mark("engine:event-load:scroll:end");
                const atEnd = Reflect.get(window, "__eventLoad").ready();
                const gaps = frameTimes
                  .slice(1)
                  .map((at, index) => at - frameTimes[index]!)
                  .toSorted((a, b) => a - b);
                return {
                  scrollFrameMedianMs: gaps[Math.floor(gaps.length / 2)]!,
                  scrollFrameP95Ms: gaps[Math.ceil(gaps.length * 0.95) - 1]!,
                  scrollFrameMaxMs: gaps.at(-1)!,
                  scrollFirstFrameMs: firstFrameMs,
                  scrollObservedMs: observedMs,
                  scrollDeliveryMs: deliveryMs,
                  scrollLoopStartedAfterMs: atStart.elapsed,
                  scrollLoopToolsAtStart: atStart.tools,
                  scrollLoopToolsAtEnd: atEnd.tools,
                  scrollLoopCompletedToolsAtStart: atStart.completedTools,
                  scrollLoopCompletedToolsAtEnd: atEnd.completedTools,
                  scrollLoopForegroundReceived: atEnd.foregroundEvents - atStart.foregroundEvents,
                  scrollLoopBackgroundReceived: atEnd.backgroundEvents - atStart.backgroundEvents,
                  blankScrollFrames: blank,
                  firstBlankFrame,
                };
              },
              undefined,
              { timeout: 120_000 },
            );
            const { firstBlankFrame, ...timings } = scroll;
            Object.assign(evidence, timings);
            if (
              count >= 0 &&
              toolCount > 1 &&
              scroll.scrollLoopToolsAtEnd <= scroll.scrollLoopToolsAtStart
            ) {
              throw new Error("Event-load scroll did not overlap foreground tool production");
            }
            if (scroll.blankScrollFrames > 0) {
              throw new Error(
                `Event load exposed ${scroll.blankScrollFrames} blank scroll frames: ${firstBlankFrame}`,
              );
            }
          });
          evidence.scrollActionWallMs = scrolling.actionWallMs;
          recordPhase("scroll", scrolling);
          const drainTimeout =
            count < 0
              ? undefined
              : Math.max(
                  1,
                  duration -
                    (await page.evaluate(() => Reflect.get(window, "__eventLoad").ready().elapsed)),
                );
          await page.waitForFunction(
            (expected) => {
              const state = Reflect.get(window, "__eventLoad").ready();
              return state.completedTools === expected && state.applicationDrained;
            },
            count === -1 ? 0 : toolCount,
            { timeout: drainTimeout },
          );
          const appliedResults = await page.evaluate(() =>
            Reflect.get(window, "__eventLoad").verifyAppliedResults(),
          );
          evidence.appliedResultCount = appliedResults.count;
          evidence.orderedAppliedResults = appliedResults.ordered;
          // These are user-idle intervals under event load, not no-work CPU claims.
          const engine = page.context().browser()!.browserType().name();
          if (engine !== "chromium" && engine !== "webkit" && engine !== "firefox") {
            throw new Error(`Unsupported idle engine: ${engine}`);
          }
          const beforeIdle = await page.evaluate(() => Reflect.get(window, "__eventLoad").ready());
          const idle = await startEngineMeasurement(page, engine, { trace: false });
          const idlePhase = await phase(page, "idle", async () => {
            evidence.idleObservedMs = await page.evaluate(async () => {
              const start = performance.now();
              await new Promise((resolve) => {
                setTimeout(resolve, 1_000);
              });
              return performance.now() - start;
            });
          });
          const idleMetrics = (await idle.stop()).metrics;
          const afterIdle = await page.evaluate(() => Reflect.get(window, "__eventLoad").ready());
          // Collector calls bracket the phase; retain their uncertainty instead of
          // attributing their CPU to only the frames received inside the phase.
          evidence.idleMinimumWindowMs = idlePhase.actionWallMs;
          evidence.idleMaximumWindowMs = afterIdle.elapsed - beforeIdle.elapsed;
          evidence.idleMinimumBackgroundFrames = idlePhase.backgroundReceived;
          evidence.idleMaximumBackgroundFrames =
            afterIdle.backgroundEvents - beforeIdle.backgroundEvents;
          recordPhase("idle", idlePhase);
          evidence.idleCpuAvailable = idleMetrics.cpuMs !== null;
          if (idleMetrics.cpuMs !== null) {
            evidence.idleCpuMs = idleMetrics.cpuMs;
          }
          if (idleMetrics.taskMs !== null) {
            evidence.idleTaskMs = idleMetrics.taskMs;
          }
          if (idleMetrics.scriptMs !== null) {
            evidence.idleScriptMs = idleMetrics.scriptMs;
          }
          if (!interactionsOnly) {
            const key = count > 0 ? background : "agent:main:interaction-b";
            const checkpoint = await page.evaluate(
              () => Reflect.get(window, "__eventLoad").ready().displayedCheckpoint,
            );
            const switching = await phase(
              page,
              "session",
              async () => {
                await navigation(page, "sessions");
                if (count > 0) {
                  await page.waitForFunction((sessionKey) => {
                    const row = document.querySelector(
                      `.sidebar-recent-session[data-session-key="${sessionKey}"]`,
                    );
                    return (
                      row?.classList.contains("session-row-host--running") &&
                      [...row.querySelectorAll(".sr-only[id]")].some((state) =>
                        state.textContent?.includes("Unread"),
                      )
                    );
                  }, key);
                  evidence.activeStatusUnreadVisible = true;
                }
                await page
                  .locator(
                    `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__link`,
                  )
                  .click();
                await page.waitForFunction(
                  (target) =>
                    Reflect.get(
                      document.querySelector(".chat-pane-cache__pane--active") ?? {},
                      "sessionKey",
                    ) === target,
                  key,
                );
                if (count > 0) {
                  await page.waitForFunction(
                    ({ key: sessionKey, checkpoint: expectedCheckpoint }) =>
                      [
                        ...document.querySelectorAll(".chat-pane-cache__pane--active .chat-text"),
                      ].some((element) => {
                        const match = /Event load checkpoint (\d+) for ([^.]+)\./u.exec(
                          element.textContent ?? "",
                        );
                        return (
                          match?.[2] === sessionKey &&
                          Number(match[1]) >= expectedCheckpoint &&
                          expectedCheckpoint > 0
                        );
                      }),
                    { key, checkpoint },
                  );
                }
                await frames(page);
              },
              key,
            );
            evidence.sessionSwitchActionWallMs = switching.actionWallMs;
            recordPhase("sessionSwitch", switching);
            if (switching.applicationMs !== undefined) {
              evidence.sessionSwitchApplicationMs = switching.applicationMs;
            }
            const route = await phase(
              page,
              "route",
              async () => {
                await navigation(page, "pages");
                await page.locator('.sidebar-pages a[href="/usage"]').click();
                await page.locator("openclaw-usage-page .usage-page").waitFor({ state: "visible" });
                await frames(page);
              },
              "openclaw-usage-page .usage-page",
            );
            evidence.routeSwitchActionWallMs = route.actionWallMs;
            recordPhase("routeSwitch", route);
            if (route.applicationMs !== undefined) {
              evidence.routeSwitchApplicationMs = route.applicationMs;
            }
          }
        } finally {
          const offered = wire.finish();
          const result = await page.evaluate(() => Reflect.get(window, "__eventLoad").finish());
          Object.assign(evidence, {
            sessionInventory: inventory,
            heldSessionRows: heldRows,
            navigationMeasured: !interactionsOnly,
            backgroundSessions: Math.max(0, count),
            producerOutsideRenderer: true,
            offeredFrames: offered.offeredFrames,
            offeredBackgroundFrames: offered.offeredBackgroundFrames,
            offeredBytes: offered.offeredBytes,
            offeredBackgroundHz: (offered.backgroundReceipts ?? 0) / (result.elapsed / 1_000),
            offeredBackgroundFrameHz: offered.offeredBackgroundFrames / (result.elapsed / 1_000),
            receivedBackgroundFrameHz: result.backgroundEvents / (result.elapsed / 1_000),
            pendingBackgroundFrames: offered.offeredBackgroundFrames - result.backgroundEvents,
            foregroundTools: result.tools,
            completedTools: result.completedTools,
            producerElapsedMs: offered.producerElapsedMs ?? 0,
            toolPreparationMs,
            liveToolOutputVisible: count >= 0,
            foregroundDrainMs: offered.foregroundDrainMs ?? 0,
            lateBackgroundEmissions: offered.lateBackgroundEmissions ?? 0,
            backgroundReceipts: result.backgroundReceipts,
            targetBackgroundReceipts: result.targetBackgroundReceipts,
            maxBackgroundSchedulerLagMs: offered.maxBackgroundSchedulerLagMs ?? 0,
            socketsOpened: result.socketsOpened,
            socketsClosed: result.socketsClosed,
            achievedBackgroundHz: result.backgroundReceipts / (result.elapsed / 1_000),
            loadElapsedMs: result.elapsed,
            maximumLoadDurationMs: duration,
            incomingEvents: result.delivered,
            incomingBytes: result.bytes,
            incomingBackgroundEvents: result.backgroundEvents,
            incomingBackgroundBytes: result.backgroundBytes,
            incomingSessionsChanged: result.byEvent["sessions.changed"] ?? 0,
            incomingSessionMessages: result.byEvent["session.message"] ?? 0,
            incomingToolEvents: (result.byEvent["session.tool"] ?? 0) + (result.byEvent.agent ?? 0),
            incomingNarrationEvents: result.byEvent["session.narration"] ?? 0,
            mutationRecords: result.mutations,
            addedRows: result.addedRows,
            inputSampleCount: result.inputSampleCount,
            inputDelayMedianMs: result.delays.median,
            inputDelayP95Ms: result.delays.p95,
            inputToFrameMedianMs: result.inputs.median,
            inputToFrameP95Ms: result.inputs.p95,
            deliveryTaskMedianMs: result.delivery.median,
            deliveryTaskP95Ms: result.delivery.p95,
            foregroundDeliveryDurationMs: result.turn.foregroundDeliveryDurationMs,
            foregroundApplicationFrameCount: result.turn.frameCount,
            foregroundApplicationFramesOver33Fraction: result.turn.framesOver33Fraction,
            foregroundApplicationFramesOver50Fraction: result.turn.framesOver50Fraction,
            longTasksSupported: result.turn.longTasksSupported,
            longestForegroundLongTaskMs: result.turn.longestLongTaskMs,
            longTaskThresholdMs: result.turn.longTaskThresholdMs,
            foregroundLongTaskCount: result.turn.longTaskCount,
            applicationDrainMs: result.turn.applicationDrainMs,
            producerToApplicationDrainMs:
              result.turn.applicationSettledAt === null
                ? null
                : result.turn.applicationSettledAt - offered.foregroundFirstEmittedAt,
            appliedResultCount: result.turn.appliedResultCount,
            orderedAppliedResults: result.turn.orderedAppliedResults,
            applicationDrainLagMs:
              result.turn.applicationSettledAt === null
                ? null
                : result.turn.applicationSettledAt - offered.foregroundLastEmittedAt,
            eventReceiptAgeMedianMs: result.turn.receiptAge.median,
            eventReceiptAgeP95Ms: result.turn.receiptAge.p95,
            eventApplicationAgeMedianMs: result.turn.applicationAge.median,
            eventApplicationAgeP95Ms: result.turn.applicationAge.p95,
            eventApplicationAgeSampleCount: result.turn.applicationAgeSampleCount,
            unobservedApplicationEvents: result.turn.unobservedApplicationEvents,
            synchronousDispatchMedianMs: result.turn.synchronousDispatch.median,
            synchronousDispatchP95Ms: result.turn.synchronousDispatch.p95,
            foregroundLastSequenceMatches:
              result.turn.foregroundLastSequence === offered.foregroundLastSequence,
            foregroundDeliveryDrainLagMs:
              result.turn.foregroundLastDeliveredAt === null
                ? null
                : result.turn.foregroundLastDeliveredAt - offered.foregroundLastEmittedAt,
          });
          await page.evaluate(
            (partial) => {
              Reflect.set(window, "__eventLoadEvidence", partial);
            },
            {
              ...evidence,
              eventLoadSeries: {
                ...result.turn,
                producerForegroundFirstEmittedAt: offered.foregroundFirstEmittedAt,
                producerForegroundLastEmittedAt: offered.foregroundLastEmittedAt,
                producerForegroundLastSequence: offered.foregroundLastSequence,
              },
            },
          );
        }
        const requests = await page.evaluate(
          (after) =>
            (window as MockGatewayWindow)
              .openclawControlUiE2eGateway!.requests.slice(after)
              .map(({ method }) => method),
          requestsBefore,
        );
        for (const method of [
          "sessions.list",
          "chat.history",
          "chat.startup",
          "sessions.messages.subscribe",
          "chat.send",
        ]) {
          evidence[`rpc:${method}`] = requests.filter((candidate) => candidate === method).length;
        }
        if (evidence["rpc:chat.send"]) {
          throw new Error("Event load typing sent a message");
        }
        evidence.inputPreserved = true;
        evidence.switchHistoryCurrent = !interactionsOnly && count > 0;
        return evidence;
      },
    };
  });
}

/** Run on a fresh, prepared event-load-0 fixture instead of its timed run. */
async function verifyEventLoadPageUp(page: Page, toolCount: number) {
  if (toolCount < 4) {
    throw new Error("PageUp overlap proof needs at least four foreground tools");
  }
  // This separate fixture does not contribute samples to the timing matrix.
  await page.evaluate((expected) => {
    const load = Reflect.get(window, "__eventLoad");
    load.start({ duration: 120_000, toolCount: expected });
    load.phase("typing", "");
  }, toolCount);
  let proofHandle:
    | JSHandle<{
        entryId: string;
        text: string;
        top: number;
        appliedAtCapture: number;
        maxDrift: number;
        samples: number;
        settledFrames: number;
      }>
    | undefined;
  try {
    // Native typing releases the first half through the same producer gate.
    await page.locator(composer).press("x");
    await page.waitForFunction(
      (firstHalf) => {
        const state = Reflect.get(window, "__eventLoad").reader();
        return state.appliedResults === firstHalf && !state.pendingToolRender;
      },
      Math.ceil(toolCount / 2),
    );
    const threadLocator = page.locator(`${pane} .chat-thread`);
    await threadLocator.press("End");
    await page.waitForFunction(() => {
      const thread = document.querySelector<HTMLElement>(
        ".chat-pane-cache__pane--active .chat-thread",
      );
      return thread && Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) <= 8;
    });
    await page.evaluate(() => Reflect.get(window, "__eventLoad").beginScroll());
    await threadLocator.press("PageUp");
    // Wait for the browser's native paging motion, not an assigned scrollTop.
    await page.waitForFunction(
      ({ expected, position }) => {
        const thread = document.querySelector<HTMLElement>(
          ".chat-pane-cache__pane--active .chat-thread",
        );
        const state = Reflect.get(window, "__eventLoad").reader();
        if (!thread || !state.followLocked || !state.readingHistory) {
          return false;
        }
        const away = thread.scrollHeight - thread.clientHeight - thread.scrollTop > 8;
        position.stable = away && position.top === thread.scrollTop ? position.stable + 1 : 0;
        position.top = thread.scrollTop;
        if (position.stable < 3) {
          return false;
        }
        if (state.appliedResults >= expected) {
          throw new Error("Foreground output drained before native PageUp overlap was captured");
        }
        return true;
      },
      { expected: toolCount, position: { top: -1, stable: 0 } },
      { polling: "raf" },
    );
    proofHandle = await threadLocator.evaluateHandle((thread) => {
      const viewport = thread.getBoundingClientRect();
      // Durable fixture messages survive the bounded live-tool window. Do not
      // capture a transient tool-result body or rely on a retained DOM identity.
      const anchor = [...thread.querySelectorAll<HTMLElement>(".chat-text")].find((element) => {
        const entryId = element
          .closest(".chat-bubble[data-entry-id]")
          ?.getAttribute("data-entry-id");
        const bounds = element.getBoundingClientRect();
        return (
          entryId &&
          /^(?:interaction-0-|event-load-call-)\d+$/u.test(entryId) &&
          !element.closest(".chat-tool-msg-body") &&
          bounds.top >= viewport.top &&
          bounds.bottom <= viewport.bottom &&
          bounds.height > 0
        );
      });
      const entryId = anchor?.closest(".chat-bubble[data-entry-id]")?.getAttribute("data-entry-id");
      if (!anchor || !entryId) {
        throw new Error("Native PageUp did not expose a complete durable text anchor");
      }
      return {
        entryId,
        text: anchor.textContent ?? "",
        top: anchor.getBoundingClientRect().top,
        appliedAtCapture: Reflect.get(window, "__eventLoad").reader().appliedResults,
        maxDrift: 0,
        samples: 0,
        settledFrames: 0,
      };
    });
    await page.waitForFunction(
      ({ proof, expected }) => {
        const thread = document.querySelector<HTMLElement>(
          ".chat-pane-cache__pane--active .chat-thread",
        );
        const state = Reflect.get(window, "__eventLoad").reader();
        const anchor = [...(thread?.querySelectorAll<HTMLElement>(".chat-text") ?? [])].find(
          (element) =>
            element.textContent === proof.text &&
            element.closest(".chat-bubble[data-entry-id]")?.getAttribute("data-entry-id") ===
              proof.entryId,
        );
        if (!thread || !anchor || !state.followLocked || !state.readingHistory) {
          throw new Error("Incoming foreground output replaced native PageUp reader intent");
        }
        const drift = Math.abs(anchor.getBoundingClientRect().top - proof.top);
        proof.maxDrift = Math.max(proof.maxDrift, drift);
        proof.samples++;
        if (drift > 2 || thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 8) {
          throw new Error(`Incoming foreground output moved the PageUp anchor by ${drift}px`);
        }
        proof.settledFrames =
          state.appliedResults === expected && !state.pendingToolRender
            ? proof.settledFrames + 1
            : 0;
        return proof.settledFrames >= 3;
      },
      { proof: proofHandle, expected: toolCount },
      { polling: "raf", timeout: 120_000 },
    );
    const applied = await page.evaluate(() =>
      Reflect.get(window, "__eventLoad").verifyAppliedResults(),
    );
    const readerEvidence = await proofHandle.evaluate((proof) => ({
      nativePageUpPreserved: true,
      pageUpAppliedAtCapture: proof.appliedAtCapture,
      pageUpMaxAnchorDriftPx: proof.maxDrift,
      pageUpSamples: proof.samples,
    }));
    if (readerEvidence.pageUpAppliedAtCapture >= toolCount) {
      throw new Error("PageUp proof captured no remaining foreground results");
    }
    return {
      correctnessOnly: true,
      ...readerEvidence,
      appliedResultCount: applied.count,
      orderedAppliedResults: applied.ordered,
    };
  } finally {
    await proofHandle?.dispose();
    await page.evaluate(() => Reflect.get(window, "__eventLoad").finish());
  }
}

/** Correctness runs after the profiler stops, so it cannot inflate event CPU. */
export async function verifyEngineEventLoad(page: Page, count: number, toolCount = 200) {
  const evidence: Record<string, boolean> = {};
  await page.evaluate(() => Reflect.get(window, "__eventLoad").settle());
  await navigation(page, "sessions");
  if (count > 0) {
    const context = await getControlUiContextHandle(page);
    try {
      await page
        .waitForFunction(
          ({ context: appContext, count: sessionCount }) => {
            const rows = appContext.sessions.state.result?.sessions;
            return Array.from({ length: sessionCount }, (_, index) =>
              index === 0 ? "agent:main:interaction-b" : `agent:main:interaction-${index + 1}`,
            ).every((key) => {
              const row = rows?.find((candidate) => candidate.key === key);
              return (
                row?.status === "done" &&
                row.hasActiveRun === false &&
                row.activeRunIds?.length === 0
              );
            });
          },
          { context, count },
        )
        .catch(async (error: unknown) => {
          const diagnostic = await page.evaluate(
            ({ context: appContext, count: sessionCount }) => {
              const rows = appContext.sessions.state.result?.sessions;
              const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
              return {
                socketCount: gateway.socketCount(),
                sockets: gateway
                  .socketStates()
                  .map(({ readyState, state }) => ({ readyState, state })),
                socketCloses: Reflect.get(window, "__eventLoad").ready().socketCloses,
                unsettled: Array.from({ length: sessionCount }, (_, index) =>
                  index === 0 ? "agent:main:interaction-b" : `agent:main:interaction-${index + 1}`,
                ).flatMap((key) => {
                  const row = rows?.find((candidate) => candidate.key === key);
                  return row?.status === "done" &&
                    row.hasActiveRun === false &&
                    row.activeRunIds?.length === 0
                    ? []
                    : [{ key, status: row?.status, active: row?.hasActiveRun }];
                }),
              };
            },
            { context, count },
          );
          throw new Error(`Background sessions did not settle: ${JSON.stringify(diagnostic)}`, {
            cause: error,
          });
        });
    } finally {
      await context.dispose();
    }
    evidence.allBackgroundSessionsSettled = true;
    const selector = `.sidebar-recent-session[data-session-key="${background}"]`;
    await page.waitForFunction((rowSelector) => {
      const row = document.querySelector(rowSelector);
      return (
        row &&
        !row.classList.contains("session-row-host--running") &&
        row.querySelector('[aria-label="Unread"]')
      );
    }, selector);
    evidence.terminalStatusVisible = true;
    evidence.terminalUnreadVisible = true;
    const expected = await page.evaluate(
      () => Reflect.get(window, "__eventLoad").ready().latestText,
    );
    await page.locator(`${selector} .sidebar-recent-session__link`).click();
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll(".chat-pane-cache__pane--active .chat-text")].some(
          (element) => element.textContent?.includes(text),
        ),
      expected,
    );
    evidence.finalSwitchHistoryCurrent = true;
    await navigation(page, "sessions");
  }
  await page
    .locator(
      `.sidebar-recent-session[data-session-key="${foreground}"] .sidebar-recent-session__link`,
    )
    .click();
  if (count >= 0) {
    await page.waitForFunction((key) => {
      const host = document.querySelector(".chat-pane-cache__pane--active");
      return (
        Reflect.get(host ?? {}, "sessionKey") === key &&
        Reflect.get(host ?? {}, "transcriptReady") === true
      );
    }, foreground);
    await frames(page);
    // Exercise an actual Latest command, rather than skipping an affordance
    // whose reactive visibility may still be settling after the retained-pane switch.
    const scrollable = await page
      .locator(`${pane} .chat-thread`)
      .evaluate((thread) => thread.scrollHeight - thread.clientHeight > 8);
    evidence.foregroundLatestActivated = scrollable;
    if (scrollable) {
      await page.locator(`${pane} .chat-thread`).press("PageUp");
      const latest = page.locator(`${pane} .chat-scroll-to-bottom`);
      await latest.waitFor({ state: "visible" });
      await latest.press("Enter");
    }
    await page
      .locator(`${pane} .chat-text`)
      .getByText("Event load foreground completed.", { exact: true })
      .waitFor();
    // Mounted final text can precede a completed Latest journey. Require both
    // visible content and the physical end to remain stable across three frames.
    await page
      .waitForFunction(
        ({ position }) => {
          const thread = document.querySelector<HTMLElement>(
            ".chat-pane-cache__pane--active .chat-thread",
          );
          const final = [...(thread?.querySelectorAll<HTMLElement>(".chat-text") ?? [])].find(
            (element) => element.textContent?.trim() === "Event load foreground completed.",
          );
          const viewport = thread?.getBoundingClientRect();
          const bounds = final?.getBoundingClientRect();
          const atEnd = Boolean(
            thread &&
            final?.checkVisibility({ checkOpacity: true, visibilityProperty: true }) &&
            viewport &&
            bounds &&
            bounds.bottom > viewport.top &&
            bounds.top < viewport.bottom &&
            bounds.right > viewport.left &&
            bounds.left < viewport.right &&
            Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) <= 8,
          );
          const geometry = JSON.stringify([
            thread?.scrollTop,
            thread?.scrollHeight,
            thread?.clientHeight,
            bounds?.top,
            bounds?.bottom,
          ]);
          position.stable = atEnd && geometry === position.geometry ? position.stable + 1 : 0;
          position.geometry = geometry;
          return position.stable >= 3;
        },
        { position: { geometry: "", stable: 0 } },
        { polling: "raf" },
      )
      .catch(async (error: unknown) => {
        const geometry = await page.evaluate(() => {
          const thread = document.querySelector<HTMLElement>(
            ".chat-pane-cache__pane--active .chat-thread",
          );
          const final = [...(thread?.querySelectorAll<HTMLElement>(".chat-text") ?? [])].find(
            (element) => element.textContent?.trim() === "Event load foreground completed.",
          );
          const bounds = final?.getBoundingClientRect();
          return {
            scrollTop: thread?.scrollTop,
            scrollHeight: thread?.scrollHeight,
            clientHeight: thread?.clientHeight,
            endDistance: thread
              ? thread.scrollHeight - thread.clientHeight - thread.scrollTop
              : null,
            viewport: thread?.getBoundingClientRect().toJSON(),
            final: bounds?.toJSON(),
            finalVisible: final?.checkVisibility({ checkOpacity: true, visibilityProperty: true }),
            tail: [...(thread?.children ?? [])].slice(-4).map((child) => ({
              tag: child.tagName,
              class: child.className,
              bounds: child.getBoundingClientRect().toJSON(),
            })),
          };
        });
        throw new Error(
          `Latest did not settle at the transcript end: ${JSON.stringify(geometry)}`,
          { cause: error },
        );
      });
    evidence.foregroundFinalVisible = true;
    evidence.foregroundLatestAtEnd = true;
    const context = await getControlUiContextHandle(page);
    try {
      await page.waitForFunction(
        ({ context: appContext, key }) => {
          const host = document.querySelector(".chat-pane-cache__pane--active");
          const row = appContext.sessions.state.result?.sessions.find(
            (candidate) => candidate.key === key,
          );
          return (
            Reflect.get(host ?? {}, "sessionKey") === key &&
            row?.hasActiveRun === false &&
            row.activeRunIds?.length === 0 &&
            !host?.querySelector(".chat-send-btn--stop")
          );
        },
        { context, key: foreground },
      );
    } finally {
      await context.dispose();
    }
    evidence.foregroundRunSettled = true;
    await page.waitForFunction(
      ({ key, count: resultCount }) => {
        const host = document.querySelector(".chat-pane-cache__pane--active");
        const snapshots:
          | Map<string, { snapshot: { messages: Array<{ role?: string; toolCallId?: string }> } }>
          | undefined = host ? Reflect.get(host, "chatMessagesBySession") : undefined;
        const messages =
          snapshots &&
          [...snapshots].find(([stored]) => stored.endsWith(`\u0000${key}`))?.[1].snapshot.messages;
        const results = new Set(
          messages
            ?.filter((message) => message.role === "toolResult")
            .map((message) => message.toolCallId),
        );
        return Array.from(
          { length: resultCount },
          (_, index) => `event-load-tool-${index + 1}`,
        ).every((id) => results.has(id));
      },
      { key: foreground, count: toolCount },
    );
    evidence.allToolResultsRetained = true;
  }
  return evidence;
}
