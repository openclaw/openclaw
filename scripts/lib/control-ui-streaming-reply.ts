import type { ToolStreamHost } from "../../ui/src/pages/chat/tool-stream-contract.ts";
import { summarizeStreamingDistribution } from "./control-ui-streaming-statistics.ts";

export function createStreamingReplyProbeInitScript(): string {
  return `;(() => { const __name = (target) => target; const summarizeStreamingDistribution = ${summarizeStreamingDistribution.toString()}; (${installStreamingReplyProbe.toString()})(); })();`;
}

function installStreamingReplyProbe() {
  const emptyCounters = {
    parseCalls: 0,
    parseChars: 0,
    parseMs: 0,
    geometryReads: 0,
    styleReads: 0,
    fragmentClones: 0,
  };
  type Delta = typeof emptyCounters & {
    index: number;
    chars: number;
    at: number;
    taskAndMicrotasksMs?: number;
    eventToNextFrameMs?: number;
  };
  let active = false;
  let startedAt = 0;
  let stoppedAt = 0;
  let current: Delta | undefined;
  let finalReceived = false;
  type Stream = { sessionKey: string; runId: string };
  let streams: Stream[] = [];
  const initialScrollHeights = new Map<string, number>();
  const paneFor = (sessionKey: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("openclaw-chat-pane")).find(
      (pane) => Reflect.get(pane, "sessionKey") === sessionKey && pane.getClientRects().length,
    );
  const toolId = (stream: Stream) => `streaming-benchmark-${stream.runId}`;
  const toolOutput = (index: number) =>
    `Synthetic tool output\n${"A completed verification step.\n".repeat(Math.floor(index / 4))}Tool progress ${index}`;
  let paneProbeAttached = false;
  let observeTextVisibility = false;
  const textVisibility: Array<{
    index: number;
    present: boolean;
    visible: boolean;
    nextFrameMs: number;
  }> = [];
  const pipeline = {
    streamWrites: 0,
    streamWriteMs: 0,
    publications: 0,
    paneRenders: 0,
    paneRenderMs: 0,
    railObservations: 0,
    rowResizeDeliveries: 0,
    timeouts: 0,
    timeoutCancellations: 0,
  };
  window.setTimeout = new Proxy(window.setTimeout, {
    apply(target, receiver, args) {
      if (active) {
        pipeline.timeouts++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  window.clearTimeout = new Proxy(window.clearTimeout, {
    apply(target, receiver, args) {
      if (active) {
        pipeline.timeoutCancellations++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  // Observe existing owners from their registration, without a production probe seam.
  const OriginalWeakMap = window.WeakMap;
  type PaneState = Pick<ToolStreamHost, "chatReasoning" | "toolStreamById">;
  const paneOwners = new OriginalWeakMap<HTMLElement, object>();
  class ProbeWeakMap<K extends WeakKey, V> extends OriginalWeakMap<K, V> {
    override set(host: K, owner: V): this {
      super.set(host, owner);
      if (typeof owner !== "object" || owner === null) {
        return this;
      }
      const fields = Reflect.get(owner, "fields");
      const subscribe = Reflect.get(owner, "subscribe");
      if (
        Array.isArray(fields) &&
        fields.includes("chatStream") &&
        typeof subscribe === "function"
      ) {
        Reflect.apply(subscribe, owner, [() => active && pipeline.publications++]);
        const descriptor = Object.getOwnPropertyDescriptor(host, "chatStream");
        if (descriptor?.set) {
          Object.defineProperty(host, "chatStream", {
            ...descriptor,
            set(value: unknown) {
              const start = performance.now();
              descriptor.set?.call(this, value);
              if (active) {
                pipeline.streamWrites++;
                pipeline.streamWriteMs += performance.now() - start;
              }
            },
          });
        }
      }
      const render = Reflect.get(owner, "render");
      if (
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        typeof render === "function"
      ) {
        paneProbeAttached = true;
        paneOwners.set(host, owner);
        Reflect.set(owner, "render", function (this: object, ...args: unknown[]) {
          const start = performance.now();
          try {
            return Reflect.apply(render, this, args);
          } finally {
            if (active) {
              pipeline.paneRenders++;
              pipeline.paneRenderMs += performance.now() - start;
            }
          }
        });
      }
      return this;
    }
  }
  window.WeakMap = ProbeWeakMap;
  const OriginalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends OriginalResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        if (active) {
          pipeline.rowResizeDeliveries += entries.filter((entry) =>
            entry.target.classList.contains("chat-virtual-row"),
          ).length;
        }
        callback(entries, observer);
      });
    }
    override observe(target: Element, options?: ResizeObserverOptions) {
      if (active && target.classList.contains("chat-position-rail__marks")) {
        pipeline.railObservations++;
      }
      super.observe(target, options);
    }
  };
  const deltas: Delta[] = [];
  const frames: number[] = [];
  const inputs: Array<{ delayMs: number; nextFrameMs?: number; chars: number }> = [];
  const sidebarInputs: Array<{ delayMs: number; commitMs?: number; nextFrameMs?: number }> = [];
  const longFrames: Array<{ start: number; duration: number; blocking: number }> = [];
  const setupLongFrames: typeof longFrames = [];
  const longTasks: Array<{ start: number; duration: number }> | null =
    PerformanceObserver.supportedEntryTypes.includes("longtask") ? [] : null;
  const commitToNextFrameMs: number[] = [];
  let commitObserver: MutationObserver | undefined;
  let measureFrames = false;
  const channel = new MessageChannel();
  const taskEnds: Array<{ delta: Delta; at: number }> = [];
  channel.port1.addEventListener("message", () => {
    const pending = taskEnds.shift();
    if (pending) {
      pending.delta.taskAndMicrotasksMs = performance.now() - pending.at;
    }
  });
  channel.port1.start();
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      socket.addEventListener("message", (event: MessageEvent) => {
        if (!active || typeof event.data !== "string") {
          return;
        }
        const frame = JSON.parse(event.data);
        if (frame.event !== "chat") {
          return;
        }
        const payload = frame.payload;
        if (payload?.state === "final") {
          finalReceived = true;
          return;
        }
        if (payload?.state !== "delta") {
          return;
        }
        current = {
          index: deltas.length + 1,
          chars: payload.message.content[0].text.length,
          at: performance.now() - startedAt,
          ...emptyCounters,
        };
        deltas.push(current);
        if (measureFrames) {
          const sample = current;
          requestAnimationFrame(() => {
            sample.eventToNextFrameMs = performance.now() - startedAt - sample.at;
          });
        }
        if (observeTextVisibility) {
          const source: string = payload.message.content[0].text;
          const boundary = source.lastIndexOf("\n\n");
          const tail = source.slice(boundary < 0 ? 0 : boundary + 2);
          // Plain paragraphs have no hidden destinations or formatting delimiters.
          if (/^[A-Za-z][A-Za-z\d .,;:'!-]{8,}$/u.test(tail)) {
            const expected = tail.trimEnd();
            const sample = current;
            queueMicrotask(() =>
              requestAnimationFrame(() => {
                // rAF precedes ResizeObserver-driven follow. Sample after layout,
                // at this frame's pre-paint boundary rather than before its scroll writes.
                const painted = new OriginalResizeObserver(() => {
                  painted.disconnect();
                  const bubble = paneFor(payload.sessionKey)?.querySelector(
                    ".chat-bubble.streaming .chat-text",
                  );
                  const viewport = bubble?.closest(".chat-thread");
                  const paragraph = Array.from(bubble?.querySelectorAll("p") ?? []).at(-1);
                  const present = paragraph?.textContent?.startsWith(expected) ?? false;
                  let visible = false;
                  if (paragraph && viewport && present) {
                    const bounds = viewport.getBoundingClientRect();
                    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
                    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                      const end = node.textContent?.lastIndexOf(expected) ?? -1;
                      if (end < 0) {
                        continue;
                      }
                      const range = document.createRange();
                      range.setStart(node, end + expected.length - 1);
                      range.setEnd(node, end + expected.length);
                      visible ||= Array.from(range.getClientRects()).some(
                        (rect) =>
                          rect.bottom > bounds.top && rect.top < bounds.bottom && rect.width > 0,
                      );
                    }
                  }
                  textVisibility.push({
                    index: sample.index,
                    present,
                    visible,
                    nextFrameMs: performance.now() - startedAt - sample.at,
                  });
                });
                painted.observe(document.documentElement);
              }),
            );
          }
        }
        taskEnds.push({ delta: current, at: performance.now() });
        channel.port2.postMessage(null);
      });
      return socket;
    },
  });
  const measureParse = <T>(source: unknown, parse: () => T): T => {
    const start = performance.now();
    try {
      return parse();
    } finally {
      if (active && current) {
        current.parseCalls++;
        current.parseChars += String(source).length;
        current.parseMs += performance.now() - start;
      }
    }
  };
  const parserPrototype: {
    parseFromString: (this: DOMParser, source: string, type: DOMParserSupportedType) => Document;
  } = DOMParser.prototype;
  const nodePrototype: { cloneNode: (this: Node, deep?: boolean) => Node } = Node.prototype;
  const cloneNode = nodePrototype.cloneNode;
  Node.prototype.cloneNode = function (this: Node, deep?: boolean) {
    if (active && current && deep && this instanceof DocumentFragment) {
      current.fragmentClones++;
    }
    return cloneNode.call(this, deep);
  };
  const parse = parserPrototype.parseFromString;
  DOMParser.prototype.parseFromString = function (this: DOMParser, source: unknown, type) {
    return measureParse(source, () => Reflect.apply(parse, this, [source, type]));
  };
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...innerHTML,
    set(value: unknown) {
      const set = () => innerHTML.set!.call(this, value);
      if (this instanceof HTMLTemplateElement) {
        measureParse(value, set);
      } else {
        set();
      }
    },
  });
  const elementPrototype: {
    getBoundingClientRect: (this: Element) => DOMRect;
  } = Element.prototype;
  const rect = elementPrototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (active && current) {
      current.geometryReads++;
    }
    return rect.call(this);
  };
  const style = window.getComputedStyle;
  window.getComputedStyle = (...args) => {
    if (active && current) {
      current.styleReads++;
    }
    return style.apply(window, args);
  };
  document.addEventListener("keydown", (event) => {
    if (!active || !event.isTrusted) {
      return;
    }
    const start = performance.now();
    const sample = { delayMs: Math.max(0, start - event.timeStamp), chars: current?.chars ?? 0 };
    inputs.push(sample);
    requestAnimationFrame(() => {
      Object.assign(sample, { nextFrameMs: performance.now() - event.timeStamp });
    });
  });
  document.addEventListener(
    "click",
    (event) => {
      if (!active || !measureFrames || !event.isTrusted || !(event.target instanceof Element)) {
        return;
      }
      const toggle = event.target.closest(".sidebar-session-pagination__button");
      if (!toggle) {
        return;
      }
      const rowSelector = ".sidebar-recent-session[data-session-key]";
      const previous = document.querySelectorAll(rowSelector).length;
      const sample: (typeof sidebarInputs)[number] = {
        delayMs: Math.max(0, performance.now() - event.timeStamp),
      };
      sidebarInputs.push(sample);
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll(rowSelector).length <= previous) {
          return;
        }
        sample.commitMs = performance.now() - event.timeStamp;
        observer.disconnect();
        requestAnimationFrame(() => {
          sample.nextFrameMs = performance.now() - event.timeStamp;
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    },
    true,
  );
  const recordLongTasks = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime >= startedAt && (!stoppedAt || entry.startTime < stoppedAt)) {
        longTasks?.push({ start: entry.startTime - startedAt, duration: entry.duration });
      }
    }
  };
  const longTaskObserver =
    longTasks === null
      ? undefined
      : new PerformanceObserver((list) => {
          if (active) {
            recordLongTasks(list.getEntries());
          }
        });
  longTaskObserver?.observe({ type: "longtask" });
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    new PerformanceObserver((list) => {
      if (!active) {
        return;
      }
      for (const entry of list.getEntries()) {
        if (entry.startTime + entry.duration <= startedAt) {
          continue;
        }
        const blocking = Reflect.get(entry, "blockingDuration");
        const targetFrames = entry.startTime < startedAt ? setupLongFrames : longFrames;
        targetFrames.push({
          start: entry.startTime - startedAt,
          duration: entry.duration,
          blocking: typeof blocking === "number" ? blocking : 0,
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  }
  const frame = (at: number) => {
    if (!active) {
      return;
    }
    frames.push(at - startedAt);
    requestAnimationFrame(frame);
  };
  Reflect.set(window, "__streamingReply", {
    prepare(input: { streams: Stream[]; growingTool: boolean }) {
      if (input.growingTool) {
        const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
        for (const stream of input.streams) {
          gateway.emit("session.tool", {
            ...stream,
            seq: 1,
            ts: Date.now(),
            stream: "tool",
            data: {
              phase: "start",
              name: "exec",
              toolCallId: toolId(stream),
              args: { command: "verify-streaming" },
            },
          });
          gateway.emit("session.tool", {
            ...stream,
            seq: 2,
            ts: Date.now(),
            stream: "tool",
            data: {
              phase: "update",
              name: "exec",
              toolCallId: toolId(stream),
              partialResult: toolOutput(0),
            },
          });
        }
      }
    },
    async start(input: {
      streams: Stream[];
      deltas: string[];
      deltasPerSecond: number;
      burstSize: number;
      observeTextVisibility?: boolean;
      growingTool: boolean;
      mixed?: { reasoning: string; toolCount: number; imageUrl: string };
    }) {
      observeTextVisibility = input.observeTextVisibility ?? false;
      measureFrames = input.mixed !== undefined;
      if (window.WeakMap === ProbeWeakMap) {
        window.WeakMap = OriginalWeakMap;
      }
      Reflect.deleteProperty(ProbeWeakMap.prototype, "set");
      streams = input.streams;
      for (const stream of streams) {
        initialScrollHeights.set(
          stream.sessionKey,
          paneFor(stream.sessionKey)!.querySelector(".chat-thread")!.scrollHeight,
        );
      }
      startedAt = performance.now();
      active = true;
      if (measureFrames) {
        commitObserver = new MutationObserver(() => {
          const committedAt = performance.now();
          requestAnimationFrame(() => commitToNextFrameMs.push(performance.now() - committedAt));
        });
        for (const stream of streams) {
          commitObserver.observe(paneFor(stream.sessionKey)!.querySelector(".chat-thread")!, {
            subtree: true,
            childList: true,
            characterData: true,
          });
        }
      }
      requestAnimationFrame(frame);
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      let mixedSequence = 0;
      const emitActivity = (
        owner: Stream,
        kind: "thinking" | "tool",
        data: Record<string, unknown>,
      ) =>
        gateway.emit("session.tool", {
          ...owner,
          seq: ++mixedSequence,
          ts: 1_800_000_400_000 + mixedSequence,
          stream: kind,
          data,
        });
      for (const [index, text] of input.deltas.entries()) {
        setTimeout(
          () => {
            for (const stream of streams) {
              gateway.emit("chat", {
                ...stream,
                seq: input.mixed ? ++mixedSequence : input.growingTool ? index * 2 + 3 : index + 1,
                state: "delta",
                message: { role: "assistant", content: [{ type: "text", text }] },
              });
              if (input.mixed && index === 0) {
                emitActivity(stream, "thinking", {
                  itemId: "mixed-reasoning",
                  text: input.mixed.reasoning,
                });
              }
              const startTools = index === Math.floor(input.deltas.length / 4);
              const finishTools = index === Math.floor(input.deltas.length / 2);
              if (input.mixed && (startTools || finishTools)) {
                for (let tool = 1; tool <= input.mixed.toolCount; tool++) {
                  emitActivity(stream, "tool", {
                    phase: startTools ? "start" : "result",
                    name: "exec",
                    toolCallId: `mixed-tool-${tool}`,
                    ...(startTools
                      ? { args: { command: `verify-mixed-${tool}` } }
                      : { result: { text: `Mixed tool result ${tool}.` } }),
                  });
                }
              }
              if (input.mixed && finishTools) {
                const messageId = `mixed-image-${stream.runId}`;
                gateway.emit("session.message", {
                  sessionKey: stream.sessionKey,
                  runId: stream.runId,
                  hasActiveRun: true,
                  messageId,
                  messageSeq: 401,
                  message: {
                    role: "toolResult",
                    toolName: "exec",
                    toolCallId: `mixed-tool-${input.mixed.toolCount}`,
                    content: [
                      {
                        type: "image",
                        artifactId: messageId,
                        data: input.mixed.imageUrl,
                        mimeType: "image/png",
                        alt: "Synthetic streaming attachment",
                        width: 64,
                        height: 64,
                      },
                    ],
                    timestamp: 1_800_000_400_000 + mixedSequence,
                    __openclaw: { id: messageId, seq: 401, runId: stream.runId },
                  },
                });
              }
              if (input.growingTool) {
                gateway.emit("session.tool", {
                  ...stream,
                  seq: index * 2 + 4,
                  ts: Date.now(),
                  stream: "tool",
                  data: {
                    phase: "update",
                    name: "exec",
                    toolCallId: toolId(stream),
                    partialResult: toolOutput(index + 1),
                  },
                });
              }
            }
          },
          ((Math.floor(index / input.burstSize) + 1) * input.burstSize * 1000) /
            input.deltasPerSecond,
        );
      }
    },
    read() {
      return { active, delivered: deltas.length, finalReceived };
    },
    sidebarInputs() {
      return sidebarInputs;
    },
    stop() {
      active = false;
      stoppedAt = performance.now();
      commitObserver?.disconnect();
      if (longTaskObserver) {
        recordLongTasks(longTaskObserver.takeRecords());
        longTaskObserver.disconnect();
      }
    },
    finish() {
      const panes = streams.map((stream) => {
        const pane = paneFor(stream.sessionKey)!;
        const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
        const bubble = pane.querySelector(".chat-bubble.streaming .chat-text");
        const bounds = pane.getBoundingClientRect();
        const result = {
          sessionKey: stream.sessionKey,
          runId: stream.runId,
          visible:
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.left < innerWidth &&
            bounds.right > 0 &&
            bounds.top < innerHeight &&
            bounds.bottom > 0,
          finalHtml: bubble?.innerHTML ?? null,
          finalText: bubble?.textContent ?? null,
          toolOutput:
            Array.from(pane.querySelectorAll(".chat-tool-msg-collapse"))
              .find((card) => card.textContent?.includes("verify-streaming"))
              ?.querySelector(".chat-tool-term__out")?.textContent ?? null,
          tailPosition: {
            initialScrollHeight: initialScrollHeights.get(stream.sessionKey)!,
            scrollHeight: thread.scrollHeight,
            clientHeight: thread.clientHeight,
            scrollTop: thread.scrollTop,
            distanceFromBottom: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
          },
        };
        const paneOwner = measureFrames ? paneOwners.get(pane) : undefined;
        const state: PaneState | undefined = paneOwner
          ? Reflect.get(paneOwner, "state")
          : undefined;
        return state
          ? Object.assign(result, {
              finalMarkdownText: Array.from(
                bubble?.querySelectorAll("h2, p, pre code, table") ?? [],
              )
                .map((block) => block.textContent ?? "")
                .join(""),
              reasoning: state.chatReasoning,
              renderedImageCount: pane.querySelectorAll(".chat-message-image").length,
              toolResults: Array.from(
                state.toolStreamById.values(),
                ({ toolCallId, output, resultReceived }) => ({
                  toolCallId,
                  output,
                  resultReceived,
                }),
              ),
            })
          : result;
      });
      if (!pipeline.streamWrites || !pipeline.publications || !paneProbeAttached) {
        throw new Error("Streaming owner probes did not capture the measured pipeline");
      }
      if (deltas.some((delta) => !Number.isFinite(delta.parseChars))) {
        throw new Error("Streaming HTML probe produced a non-finite character count");
      }
      const distribution = summarizeStreamingDistribution;
      const optionalDistribution = (values: Array<number | undefined>) =>
        distribution(values.filter((value): value is number => value !== undefined));
      const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
      const buckets = Array.from({ length: 4 }, (_, index) => {
        const samples = deltas.slice(
          Math.floor((deltas.length * index) / 4),
          Math.floor((deltas.length * (index + 1)) / 4),
        );
        return {
          fromChars: samples[0]?.chars,
          toChars: samples.at(-1)?.chars,
          count: samples.length,
          taskAndMicrotasksMs: optionalDistribution(
            samples.map((sample) => sample.taskAndMicrotasksMs),
          ),
          parseCalls: samples.reduce((sum, sample) => sum + sample.parseCalls, 0),
          parseChars: samples.reduce((sum, sample) => sum + sample.parseChars, 0),
          parseMs: samples.reduce((sum, sample) => sum + sample.parseMs, 0),
          geometryReads: samples.reduce((sum, sample) => sum + sample.geometryReads, 0),
          styleReads: samples.reduce((sum, sample) => sum + sample.styleReads, 0),
        };
      });
      return {
        measurement:
          "Streaming interval only; see the run manifest for tracing overhead. Per-delta taskAndMicrotasksMs is delivery to a MessageChannel task (includes app microtasks and scheduling delay). Parse/geometry/style totals include asynchronous work until the next delta. Event-to-frame starts at WebSocket delivery; commit-to-frame starts at a transcript MutationObserver callback. Both end at rAF, not paint. Frame loss assumes 60 Hz; keydown samples are trusted native input to next rAF, not presentation timestamps.",
        startedAt,
        elapsedMs: stoppedAt - startedAt,
        pipeline,
        tailPosition: panes[0]!.tailPosition,
        panes,
        rig: {
          loaf: Reflect.get(window, "__perf")?.loaf?.filter(
            (entry: { start: number }) => entry.start >= startedAt,
          ),
          mutations: Object.fromEntries(Reflect.get(window, "__perf")?.mut ?? []),
          ws: Reflect.get(window, "__wsLog"),
        },
        deltas,
        buckets,
        frameGapsMs: distribution(gaps),
        estimatedDroppedFrames: gaps.reduce(
          (sum, gap) => sum + Math.max(0, Math.round(gap / (1000 / 60)) - 1),
          0,
        ),
        longFrames,
        longTasks,
        eventToNextFrameMs: optionalDistribution(deltas.map((delta) => delta.eventToNextFrameMs)),
        commitToNextFrameMs: distribution(commitToNextFrameMs),
        taskAndMicrotasksMs: optionalDistribution(deltas.map((delta) => delta.taskAndMicrotasksMs)),
        setupLongFrames,
        longFrameBlockingMs: longFrames.reduce((sum, item) => sum + item.blocking, 0),
        inputs,
        sidebarInputs,
        textVisibility,
        inputDelayMs: distribution(inputs.map((sample) => sample.delayMs)),
        inputToNextFrameMs: optionalDistribution(inputs.map((sample) => sample.nextFrameMs)),
        finalHtml: panes[0]!.finalHtml,
      };
    },
  });
}
