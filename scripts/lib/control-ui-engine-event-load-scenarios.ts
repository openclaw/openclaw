import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
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

/** Serialized after the existing mock: its subscription owner still decides delivery. */
function installEventLoadProbe() {
  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
  let active = false;
  let started = 0;
  let loadDeadline = 0;
  let delivered = 0;
  let bytes = 0;
  let backgroundEvents = 0;
  let foregroundEvents = 0;
  let backgroundBytes = 0;
  let mutations = 0;
  let addedRows = 0;
  let tools = 0;
  let completedTools = 0;
  let producerElapsedMs = 0;
  let lateBackgroundEmissions = 0;
  let backgroundReceipts = 0;
  let targetBackgroundReceipts = 0;
  let maxBackgroundSchedulerLagMs = 0;
  let liveProvenAt = 0;
  let typingStartedAt = 0;
  let admitTypingTools = () => {};
  let admitScrollTools = () => {};
  let foregroundCompletedAt = 0;
  let settle: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sequence = 0;
  let latestText = "";
  let displayedCheckpoint = 0;
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
  let socketGeneration = 0;
  let connectedGeneration = 0;
  let socketRequestStart = 0;
  const subscriptions = new Map<string, string>();
  const subscriptionModes = new Map<string, string | undefined>();
  const socketCloses: Array<{ code: number; reason: string }> = [];
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      socketRequestStart = gateway.requests.length;
      const socket: WebSocket = Reflect.construct(target, args);
      const generation = ++socketGeneration;
      socket.addEventListener("close", (event) => {
        if (connectedGeneration === generation) {
          connectedGeneration = 0;
          subscriptions.clear();
          subscriptionModes.clear();
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
          }
        }
        if (!active) {
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
  let observedKeys: string[] = [];
  const histories = new Map<string, unknown[]>();
  const history = (key: string) => {
    const row = gateway.getSessionRow(key);
    const runId = Array.isArray(row?.activeRunIds) ? row.activeRunIds[0] : undefined;
    return {
      sessionId: row?.sessionId,
      sessionInfo: row,
      messages: histories.get(key) ?? [],
      thinkingLevel: null,
      // Match the existing mock's authoritative in-flight snapshot on history reads.
      inFlightRun:
        row?.hasActiveRun && typeof runId === "string"
          ? { runId, text: "", startedAt: 1_800_000_400_000 }
          : null,
    };
  };
  Reflect.set(window, "__eventLoad", {
    start(options: {
      count: number;
      duration: number;
      toolCount: number;
      foreground: string;
      background: string;
      receiptDefaults: Record<string, unknown>;
      referenceFields: string[];
    }) {
      active = true;
      started = performance.now();
      loadDeadline = started + options.duration;
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        subtree: true,
      });
      const keys = Array.from({ length: options.count }, (_, index) =>
        index === 0 ? options.background : `agent:main:interaction-${index + 1}`,
      );
      observedKeys = [...new Set([options.foreground, options.background, ...keys])];
      let foregroundMessageSeq = 400;
      const initialMessages: Record<string, unknown>[] = Array.from(
        { length: 400 },
        (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Transcript 0 message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
          timestamp: 1_800_000_000_000 + index * 1_000,
          __openclaw: { id: `interaction-0-${index}`, seq: index + 1 },
        }),
      );
      histories.set(options.foreground, initialMessages);
      histories.set(options.background, [
        {
          role: "assistant",
          content: "Event load checkpoint 0.",
          timestamp: 1_800_000_000_000,
          __openclaw: { id: "event-load-background-initial", seq: 1 },
        },
      ]);
      const messageSequences = new Map<string, number>([[options.background, 1]]);
      subscriptions.clear();
      subscriptionModes.clear();
      const recordSubscription = (method: string, params: unknown) => {
        if (
          method !== "sessions.messages.subscribe" &&
          method !== "sessions.messages.unsubscribe"
        ) {
          return;
        }
        const input = params as { key: string; subscriptionId?: string; mode?: string };
        const id = input.subscriptionId ?? input.key;
        if (method === "sessions.messages.subscribe") {
          subscriptions.set(id, input.key);
          subscriptionModes.set(id, input.mode);
        } else {
          subscriptions.delete(id);
          subscriptionModes.delete(id);
        }
      };
      // Closed transports retire their leases without unsubscribe requests.
      for (const request of gateway.requests.slice(socketRequestStart)) {
        recordSubscription(request.method, request.params);
      }
      // A later subscription gets current authoritative history, not replayed offscreen deltas.
      for (const method of ["chat.history", "chat.startup"]) {
        gateway.setRequestHandler(method, ({ params, respond }) => {
          const key = (params as { sessionKey?: string }).sessionKey ?? options.foreground;
          respond(history(key));
        });
      }
      gateway.setRequestHandler("sessions.messages.subscribe", ({ params, respond }) => {
        const input = params as { key: string; initialHistory?: unknown };
        recordSubscription("sessions.messages.subscribe", params);
        respond({
          key: input.key,
          ...(input.initialHistory
            ? { initialHistory: { ok: true, payload: history(input.key) } }
            : {}),
        });
      });
      gateway.setRequestHandler("sessions.messages.unsubscribe", ({ params, respond }) => {
        recordSubscription("sessions.messages.unsubscribe", params);
        respond({ ok: true });
      });
      const toolSnapshot = (key: string) => {
        const row = gateway.getSessionRow(key);
        const full: Record<string, unknown> = { ...options.receiptDefaults, ...row };
        const fields = Object.fromEntries(
          options.referenceFields
            .filter((field) => full[field] !== undefined)
            .map((field) => [field, full[field]]),
        );
        // Unlike roster deltas, the observed OpenClaw agent tool path carries a
        // plain full row plus its duplicated event receipts (server-chat.ts).
        return { ...options.receiptDefaults, ...fields, session: full };
      };
      // Each connection starts without row baselines, then advances the negotiated delta wire.
      const wireRows = new Map<string, { version: number; row: Record<string, unknown> }>();
      let wireGeneration = connectedGeneration;
      const emitSnapshot = (
        event: string,
        envelope: Record<string, unknown>,
        row: Record<string, unknown>,
      ) => {
        if (!connectedGeneration) {
          return;
        }
        if (wireGeneration !== connectedGeneration) {
          wireRows.clear();
          wireGeneration = connectedGeneration;
        }
        const key = row.key as string;
        const previous = wireRows.get(key);
        const version = (previous?.version ?? 0) + 1;
        const changed: Record<string, unknown> = {};
        if (previous && previous.row !== row) {
          for (const field of [
            "updatedAt",
            "snapshotAt",
            "unread",
            "lastMessageAt",
            "lastMessagePreview",
            "lastAssistantMessage",
            "agentStatus",
          ]) {
            if (row[field] !== previous.row[field]) {
              changed[field] = row[field];
            }
          }
          if (row.hasActiveRun !== previous.row.hasActiveRun) {
            changed.hasActiveRun = row.hasActiveRun;
            changed.activeRunIds = row.activeRunIds;
            changed.status = row.status;
          }
        }
        const session = previous
          ? { key, agentId: row.agentId, version, base: previous.version, set: changed, remove: [] }
          : { key, agentId: row.agentId, version, full: row };
        wireRows.set(key, { version, row });
        // The wire contract indexes sorted defined fields of the reconstructed full
        // row, not patch keys. Captured field names survive our fixture identities.
        const fields = Object.keys(row)
          .filter((field) => row[field] !== undefined)
          .toSorted();
        const references = options.referenceFields
          .map((field) => fields.indexOf(field))
          .filter((index) => index >= 0);
        gateway.emit(event, {
          ...options.receiptDefaults,
          ...envelope,
          agentStatus: row.agentStatus ?? null,
          lastAssistantMessage: row.lastAssistantMessage ?? null,
          session,
          sessionFieldRefs: references,
        });
      };
      const emitRow = (key: string, terminal: boolean, publishStatus: boolean, tick = 0) => {
        const previous = gateway.getSessionRow(key);
        const ts = 1_800_001_000_000 + ++sequence;
        const text = `Event load checkpoint ${sequence} for ${key}.`;
        const displayed = terminal || tick % 2 === 1;
        const row = {
          ...previous,
          updatedAt: ts,
          snapshotAt: ts,
          hasActiveRun: !terminal,
          activeRunIds: terminal ? [] : [`event-load-${key}`],
          status: terminal ? "done" : "running",
          unread: true,
          lastMessagePreview: text,
          ...(displayed ? { lastAssistantMessage: { text, timestamp: ts } } : {}),
          ...(publishStatus ? { agentStatus: { note: text, expiresAt: ts + 60_000 } } : {}),
        };
        gateway.setSessionRow(row);
        const envelope = {
          sessionKey: key,
          agentId: "main",
          ...(terminal ? { runId: `event-load-${key}` } : {}),
          ts,
          ancestorSessions: [],
        };
        if (terminal || publishStatus) {
          emitSnapshot(
            "sessions.changed",
            {
              ...envelope,
              reason: terminal ? "lifecycle" : "patch",
              ...(terminal ? { phase: "end" } : {}),
            },
            row,
          );
        }
        {
          const messageSeq = (messageSequences.get(key) ?? 0) + 1;
          messageSequences.set(key, messageSeq);
          const id = `event-load-message-${key}-${messageSeq}`;
          const toolCallId = `background-tool-${Math.ceil(tick / 2)}`;
          const message = {
            role: displayed ? "assistant" : "toolResult",
            ...(displayed && !terminal ? { stopReason: "toolUse" } : {}),
            ...(!displayed ? { toolName: "exec", toolCallId } : {}),
            content:
              displayed && !terminal
                ? [
                    { type: "text", text },
                    {
                      type: "toolCall",
                      id: toolCallId,
                      name: "exec",
                      arguments: { command: "verify-background" },
                    },
                  ]
                : [{ type: "text", text }],
            timestamp: ts,
            __openclaw: { id, seq: messageSeq, runId: `event-load-${key}` },
          };
          const messages = histories.get(key) ?? [];
          messages.push(message);
          histories.set(key, messages);
          emitSnapshot(
            displayed ? "session.message" : "sessions.changed",
            {
              ...envelope,
              messageId: id,
              messageSeq,
              ...(!displayed ? { phase: "message" } : {}),
              ...(displayed && [...subscriptions.values()].includes(key) ? { message } : {}),
            },
            row,
          );
          if (key === options.background) {
            latestText = text;
          }
          if (key === options.background && displayed) {
            displayedCheckpoint = sequence;
          }
          const subscribers = [...subscriptions].filter(([, candidate]) => candidate === key);
          if (subscribers.length && !terminal) {
            const full = subscribers.some(
              ([subscriptionId]) => subscriptionModes.get(subscriptionId) !== "narration",
            );
            const start = tick % 2 === 1;
            gateway.emit("agent", {
              ...toolSnapshot(key),
              sessionKey: key,
              agentId: "main",
              runId: `event-load-${key}`,
              seq: ++sequence,
              ts,
              stream: "tool",
              data: {
                phase: start ? "start" : "result",
                name: "exec",
                toolCallId,
                ...(full
                  ? start
                    ? { args: { command: "verify-background" } }
                    : { result: { text } }
                  : {}),
              },
            });
            if (publishStatus) {
              gateway.emit("session.narration", {
                sessionKey: key,
                agentId: "main",
                runId: `event-load-${key}`,
                text,
              });
            }
          }
        }
      };
      const backgroundSchedules = keys.map((key, index) => ({
        key,
        tick: 0,
        next: started + (index * 500) / keys.length,
      }));
      const ticksPerSession = Math.floor(options.duration / 500);
      targetBackgroundReceipts = keys.length * ticksPerSession;
      const emitTool = (tool: number, data: Record<string, unknown>) =>
        gateway.emit("agent", {
          ...toolSnapshot(options.foreground),
          sessionKey: options.foreground,
          runId: "event-load-foreground",
          stream: "tool",
          seq: ++sequence,
          ts: 1_800_001_000_000 + sequence,
          data: { name: "exec", toolCallId: `event-load-tool-${tool}`, ...data },
        });
      const commitForegroundToolMessage = (tool: number, result: boolean) => {
        const toolCallId = `event-load-tool-${tool}`;
        const id = `event-load-${result ? "result" : "call"}-${tool}`;
        const ts = 1_800_001_000_000 + ++sequence;
        const text = `Tool ${tool} ${result ? "complete" : "started"}.`;
        const messageSeq = ++foregroundMessageSeq;
        const message = {
          role: result ? "toolResult" : "assistant",
          ...(!result ? { stopReason: "toolUse" } : {}),
          ...(result ? { toolName: "exec", toolCallId } : {}),
          content: result
            ? [{ type: "text", text }]
            : [
                { type: "text", text },
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "exec",
                  arguments: { command: `verify-event-load-${tool}` },
                },
              ],
          timestamp: ts,
          __openclaw: { id, seq: messageSeq, runId: "event-load-foreground" },
        };
        initialMessages.push(message);
        const row = {
          ...gateway.getSessionRow(options.foreground),
          updatedAt: ts,
          snapshotAt: ts,
          lastMessagePreview: text,
          ...(result ? { agentStatus: { note: text, expiresAt: ts + 60_000 } } : {}),
        };
        gateway.setSessionRow(row);
        const envelope = {
          sessionKey: options.foreground,
          agentId: "main",
          ancestorSessions: [],
          ts,
        };
        // Hidden toolResult bodies advance the durable cursor through the same
        // phase:message receipt used by server-session-events.ts.
        emitSnapshot(
          result ? "sessions.changed" : "session.message",
          {
            ...envelope,
            messageId: id,
            messageSeq,
            ...(result ? { phase: "message" } : { message }),
          },
          row,
        );
      };
      settle = () => {
        for (const key of keys) {
          emitRow(key, true, true);
        }
        if (!options.toolCount) {
          return;
        }
        const text = "Event load foreground completed.";
        const timestamp = 1_800_002_000_000;
        const messageId = "event-load-final";
        const messageSeq = ++foregroundMessageSeq;
        const message = {
          role: "assistant",
          content: text,
          timestamp,
          stopReason: "stop",
          __openclaw: {
            id: messageId,
            seq: messageSeq,
            runId: "event-load-foreground",
          },
        };
        histories.get(options.foreground)!.push(message);
        gateway.setSessionRow({
          ...gateway.getSessionRow(options.foreground),
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          updatedAt: timestamp,
          snapshotAt: timestamp,
          lastMessageAt: timestamp,
          lastMessagePreview: text,
        });
        const envelope = {
          sessionKey: options.foreground,
          agentId: "main",
          runId: "event-load-foreground",
          ts: timestamp,
          ancestorSessions: [],
        };
        emitSnapshot(
          "session.message",
          {
            ...envelope,
            messageId,
            messageSeq,
            message,
          },
          gateway.getSessionRow(options.foreground),
        );
        gateway.emit("chat", {
          sessionKey: options.foreground,
          runId: "event-load-foreground",
          seq: ++sequence,
          state: "final",
          stopReason: "stop",
          message: { role: "assistant", content: [{ type: "text", text }], timestamp },
        });
        emitSnapshot(
          "sessions.changed",
          { ...envelope, phase: "end", reason: "lifecycle" },
          gateway.getSessionRow(options.foreground),
        );
      };
      // Delivery may be late, but a socket backlog preserves the producer's
      // original ordering and lifetimes instead of restarting overdue tools.
      const toolEvents: Array<{ tool: number; stage: number; at: number }> = [];
      let toolEventIndex = 0;
      const toolInterval =
        Math.min(options.duration / 2, 6_000) / Math.max(1, options.toolCount - 1);
      const firstWaveTools = Math.ceil(options.toolCount / 2);
      let firstWaveLastStart = 0;
      const scheduleTool = (tool: number, at: number, stages = 4) => {
        for (let stage = 0; stage < stages; stage++) {
          toolEvents.push({ tool, stage, at: at + stage * 40 });
        }
      };
      const sortToolEvents = () => {
        toolEvents.splice(0, toolEventIndex);
        toolEventIndex = 0;
        toolEvents.sort((left, right) => left.at - right.at);
      };
      if (options.toolCount) {
        // Hold the first tool's proven live output until native typing begins.
        scheduleTool(1, performance.now(), 3);
      }
      admitTypingTools = () => {
        if (!options.toolCount) {
          return;
        }
        const at = performance.now();
        toolEvents.push({ tool: 1, stage: 3, at });
        for (let tool = 2; tool <= firstWaveTools; tool++) {
          scheduleTool(tool, at + (tool - 2) * toolInterval);
        }
        firstWaveLastStart = at + Math.max(0, firstWaveTools - 2) * toolInterval;
        sortToolEvents();
      };
      admitScrollTools = () => {
        // A sole first-wave tool was already running before typing began.
        const at = Math.max(
          performance.now(),
          firstWaveTools === 1 ? 0 : firstWaveLastStart + toolInterval,
        );
        for (let tool = firstWaveTools + 1; tool <= options.toolCount; tool++) {
          scheduleTool(tool, at + (tool - firstWaveTools - 1) * toolInterval);
        }
        sortToolEvents();
      };
      timer = setInterval(() => {
        const producerStarted = performance.now();
        const now = performance.now();
        // Independent sessions have deterministic phases and a finite socket-like
        // backlog. Drain at most one due receipt/session/tick; never drop final work.
        for (const schedule of backgroundSchedules) {
          if (schedule.tick >= ticksPerSession || now < schedule.next) {
            continue;
          }
          const late = performance.now() - schedule.next;
          if (late > 25) {
            lateBackgroundEmissions++;
          }
          maxBackgroundSchedulerLagMs = Math.max(maxBackgroundSchedulerLagMs, late);
          schedule.tick++;
          backgroundReceipts++;
          emitRow(schedule.key, false, schedule.tick % 4 === 0, schedule.tick);
          schedule.next += 500;
        }
        while (toolEventIndex < toolEvents.length && toolEvents[toolEventIndex]!.at <= now) {
          const { tool, stage } = toolEvents[toolEventIndex++]!;
          if (stage === 0) {
            tools++;
            emitTool(tool, { phase: "start", args: { command: `verify-event-load-${tool}` } });
            commitForegroundToolMessage(tool, false);
          } else if (stage < 3) {
            emitTool(tool, {
              phase: "update",
              partialResult: `Tool ${tool}: live output ${stage}\n`,
            });
          } else {
            emitTool(tool, {
              phase: "result",
              result: { text: `Tool ${tool} complete.` },
            });
            completedTools++;
            commitForegroundToolMessage(tool, true);
          }
        }
        if (options.toolCount && completedTools === options.toolCount && !foregroundCompletedAt) {
          foregroundCompletedAt = performance.now();
        }
        // Includes synchronous mock delivery and app handlers, so it is not subtractable CPU.
        producerElapsedMs += performance.now() - producerStarted;
      }, 20);
    },
    phase(kind: string, target: string) {
      phaseStart = performance.now();
      phaseInput = 0;
      phaseCommit = 0;
      phaseKind = kind;
      phaseTarget = target;
      phaseBackgroundEvents = backgroundEvents;
      phaseBackgroundReceipts = backgroundReceipts;
      phaseTools = tools;
      phaseCompletedTools = completedTools;
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
      cancelAnimationFrame(phaseFrame);
      return {
        actionWallMs: performance.now() - phaseStart,
        applicationMs: phaseCommit && phaseInput ? phaseCommit - phaseInput : undefined,
        backgroundReceived: backgroundEvents - phaseBackgroundEvents,
        backgroundReceiptsAtStart: phaseBackgroundReceipts,
        startedAfterMs: phaseStart - started,
        backgroundReceiptsAtEnd: backgroundReceipts,
        toolsAtStart: phaseTools,
        toolsAtEnd: tools,
        completedToolsAtStart: phaseCompletedTools,
        completedToolsAtEnd: completedTools,
        backgroundActiveAtStart:
          phaseStart < loadDeadline && phaseBackgroundReceipts < targetBackgroundReceipts,
        backgroundActiveAtEnd:
          performance.now() < loadDeadline && backgroundReceipts < targetBackgroundReceipts,
      };
    },
    ready() {
      return {
        tools,
        completedTools,
        backgroundEvents,
        foregroundEvents,
        backgroundReceipts,
        targetBackgroundReceipts,
        elapsed: performance.now() - started,
        phaseStartedAt: phaseStart,
        phaseInputAt: phaseInput,
        latestText,
        displayedCheckpoint,
        socketGeneration,
        connectedGeneration,
        socketCloses,
      };
    },
    currentRows() {
      return observedKeys.map((key) => gateway.getSessionRow(key));
    },
    liveProven() {
      liveProvenAt = performance.now();
    },
    beginScroll() {
      admitScrollTools();
    },
    settle() {
      settle?.();
    },
    finish() {
      clearInterval(timer);
      const elapsed = performance.now() - started;
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
        tools,
        completedTools,
        producerElapsedMs,
        liveProofMs: liveProvenAt ? liveProvenAt - started : 0,
        foregroundDrainMs: foregroundCompletedAt ? foregroundCompletedAt - started : 0,
        lateBackgroundEmissions,
        backgroundReceipts,
        targetBackgroundReceipts,
        maxBackgroundSchedulerLagMs,
        socketsOpened: socketGeneration,
        socketsClosed: socketCloses.length,
        byEvent,
        inputSampleCount: inputs.length,
        inputs: distribution(inputs),
        delays: distribution(delays),
        delivery: distribution(taskSpans),
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
): EngineScenario[] {
  return [-1, 0, 5, 20, 100].map((count) => {
    let requestPage: Page;
    let roster: ReturnType<typeof createTeamScaleSidebarListOwner>;
    return {
      id: count === -1 ? "event-load-unloaded" : `event-load-${count}`,
      explicitOnly: true,
      route: controlUiSessionPath(foreground),
      expected: `${Math.max(0, count)} background sessions at one tool/s (two durable-message receipts/s and one status patch/2 s) plus ${count === -1 ? 0 : toolCount} foreground tools preserve typing, scroll, route/session switches and current history.`,
      initScript: `${engineProbeInitScript()};(() => { const __name = (value) => value; (${installEventLoadProbe.toString()})(); })();`,
      settings: { chatShowToolCalls: true, sidebarLiveActivity: true, sidebarAgentsMode: "chip" },
      setup: async (page) => {
        requestPage = page;
      },
      createRequestHandlers: () => ({
        "sessions.list": async (params) => {
          if (!isRecord(params)) {
            throw new Error("Expected sessions.list parameters");
          }
          const currentRows = await requestPage.evaluate(() =>
            Reflect.get(window, "__eventLoad").currentRows(),
          );
          roster.apply({ upsert: currentRows });
          return roster.list(params).result;
        },
      }),
      fixtureOverrides: (_sandbox, base) => {
        const sessions = base.sessions.map<(typeof base.sessions)[number]>((input, index) => {
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
        roster = createTeamScaleSidebarListOwner({
          rows: sessions,
          viewerProfileId: "interaction-viewer",
          now: 1_800_000_000_000,
          defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
          owners: [],
        });
        return {
          sessions,
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
      },
      run: async (page) => {
        const requestsBefore = await page.evaluate(
          () => (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests.length,
        );
        await page.evaluate((options) => Reflect.get(window, "__eventLoad").start(options), {
          count: Math.max(0, count),
          duration,
          toolCount: count === -1 ? 0 : toolCount,
          foreground,
          background,
          receiptDefaults: eventLoadReceiptDefaults,
          referenceFields: eventLoadReferenceFields,
        });
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
          if (count >= 0) {
            await page.waitForFunction(() => Reflect.get(window, "__eventLoad").ready().tools > 0);
            const summary = page
              .locator(`${pane} .chat-tool-msg-summary[aria-expanded]`)
              .filter({ hasText: "verify-event-load-1" });
            await summary.waitFor({ state: "visible" });
            if ((await summary.getAttribute("aria-expanded")) === "false") {
              await summary.press("Enter");
            }
            const tool = page
              .locator(`${pane} .chat-tool-msg-collapse`)
              .filter({ hasText: "verify-event-load-1" })
              .first();
            await tool.waitFor({ state: "visible" });
            await tool
              .getByText("Tool 1: live output 2", { exact: false })
              .waitFor({ state: "visible" });
            await page.evaluate(() => Reflect.get(window, "__eventLoad").liveProven());
            evidence.liveToolOutputVisible = true;
          }
          const text = "Event load typing preserves every character.";
          const typing = await phase(page, "typing", async () => {
            await page.locator(composer).pressSequentially(text, { delay: 35 });
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
            (expected) => Reflect.get(window, "__eventLoad").ready().completedTools === expected,
            count === -1 ? 0 : toolCount,
            { timeout: drainTimeout },
          );
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
        } finally {
          const result = await page.evaluate(() => Reflect.get(window, "__eventLoad").finish());
          Object.assign(evidence, {
            backgroundSessions: Math.max(0, count),
            foregroundTools: result.tools,
            completedTools: result.completedTools,
            producerElapsedMs: result.producerElapsedMs,
            liveProofMs: result.liveProofMs,
            foregroundDrainMs: result.foregroundDrainMs,
            lateBackgroundEmissions: result.lateBackgroundEmissions,
            backgroundReceipts: result.backgroundReceipts,
            targetBackgroundReceipts: result.targetBackgroundReceipts,
            maxBackgroundSchedulerLagMs: result.maxBackgroundSchedulerLagMs,
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
          });
          await page.evaluate((partial) => {
            Reflect.set(window, "__eventLoadEvidence", partial);
          }, evidence);
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
        evidence.switchHistoryCurrent = count > 0;
        return evidence;
      },
    };
  });
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
    // The scroll exercise deliberately leaves the retained pane reading older history.
    const latest = page.locator(`${pane} .chat-scroll-to-bottom`);
    if (await latest.isVisible()) {
      await latest.press("Enter");
    }
    await page
      .locator(`${pane} .chat-text`)
      .getByText("Event load foreground completed.", { exact: true })
      .waitFor();
    evidence.foregroundFinalVisible = true;
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
