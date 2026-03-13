/**
 * ACP-style SSE Buffer Relay
 *
 * Consumes LangGraph streaming events and relays progress/completion
 * to the user via SystemEvent + HeartbeatWake.
 *
 * Pattern reference: src/agents/acp-spawn-parent-stream.ts
 */

import type { LangGraphStreamEvent } from "./langgraph-client.js";

const STREAM_SNIPPET_MAX_CHARS = 220;
const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 600_000; // 10 min

/** LangGraph node name → user-facing Chinese label */
const NODE_LABELS: Record<string, string> = {
  analyzer: "分析市场结构",
  data_fetcher: "获取市场数据",
  strategy_designer: "设计策略",
  backtester: "回测验证",
  risk_evaluator: "评估风险",
  report_generator: "生成报告",
  factor_screener: "因子筛选",
  valuation: "估值分析",
  sentiment: "情绪分析",
  macro: "宏观分析",
  // fallback handled in code
};

export type StreamRelayConfig = {
  taskId: string;
  sessionKey: string;
  productName: string; // "Findoo Alpha"
  label: string; // "茅台市场分析"
  enqueueSystemEvent: (text: string, options: { sessionKey: string; contextKey?: string }) => void;
  requestHeartbeatNow: (options?: { reason?: string; sessionKey?: string }) => void;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  maxRelayLifetimeMs?: number;
};

export type StreamRelayHandle = {
  /** Promise that resolves when the relay finishes (complete/error/timeout) */
  done: Promise<{ status: "completed" | "failed" | "timeout" | "stalled"; finalText?: string }>;
  /** Abort the relay early */
  abort: () => void;
};

export function startStreamRelay(
  stream: AsyncIterable<LangGraphStreamEvent>,
  config: StreamRelayConfig,
): StreamRelayHandle {
  const flushMs = config.streamFlushMs ?? DEFAULT_STREAM_FLUSH_MS;
  const noOutputMs = config.noOutputNoticeMs ?? DEFAULT_NO_OUTPUT_NOTICE_MS;
  const maxLifetimeMs = config.maxRelayLifetimeMs ?? DEFAULT_MAX_RELAY_LIFETIME_MS;

  let aborted = false;
  let pendingText = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  const contextKeyPrefix = `findoo:alpha:${config.taskId}`;

  function emitEvent(text: string, suffix: string) {
    config.enqueueSystemEvent(text, {
      sessionKey: config.sessionKey,
      contextKey: `${contextKeyPrefix}:${suffix}`,
    });
    config.requestHeartbeatNow({
      reason: "wake",
      sessionKey: config.sessionKey,
    });
  }

  function flushPending() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!pendingText || aborted) return;

    let snippet = pendingText.replace(/\s+/g, " ").trim();
    if (snippet.length > STREAM_SNIPPET_MAX_CHARS) {
      snippet = snippet.slice(0, STREAM_SNIPPET_MAX_CHARS) + "…";
    }
    pendingText = "";

    if (snippet) {
      emitEvent(`${config.productName} ${config.label}进度：${snippet}`, "progress");
    }
  }

  function scheduleFlush() {
    if (flushTimer || aborted) return;
    flushTimer = setTimeout(flushPending, flushMs);
  }

  function extractText(event: LangGraphStreamEvent): { nodeName?: string; text?: string } {
    const data = event.data;

    // LangGraph "updates" format: { <node_name>: { messages: [...] } } or { <node_name>: { output: "..." } }
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== "object" || val === null) continue;
      const nodeData = val as Record<string, unknown>;

      // Try messages array (LangGraph standard)
      if (Array.isArray(nodeData.messages)) {
        const lastMsg = nodeData.messages[nodeData.messages.length - 1] as
          | { content?: string }
          | undefined;
        if (lastMsg?.content && typeof lastMsg.content === "string") {
          return { nodeName: key, text: lastMsg.content };
        }
      }

      // Try output field
      if (typeof nodeData.output === "string") {
        return { nodeName: key, text: nodeData.output };
      }

      // Try content field
      if (typeof nodeData.content === "string") {
        return { nodeName: key, text: nodeData.content };
      }
    }

    return {};
  }

  const done = new Promise<{
    status: "completed" | "failed" | "timeout" | "stalled";
    finalText?: string;
  }>((resolve) => {
    const lifetimeTimer = setTimeout(() => {
      aborted = true;
      flushPending();
      emitEvent(
        `${config.productName} ${config.label}超时（超过${Math.round(maxLifetimeMs / 60_000)}分钟），请稍后重试。`,
        "error",
      );
      resolve({ status: "timeout" });
    }, maxLifetimeMs);

    const stallChecker = setInterval(() => {
      if (aborted) {
        clearInterval(stallChecker);
        return;
      }
      if (Date.now() - lastOutputAt > noOutputMs) {
        emitEvent(`${config.productName} ${config.label}正在处理中，请耐心等待…`, "stall");
        lastOutputAt = Date.now(); // reset to avoid repeated stall notices
      }
    }, noOutputMs / 2);

    (async () => {
      try {
        let finalText = "";

        for await (const event of stream) {
          if (aborted) break;
          lastOutputAt = Date.now();

          if (event.event === "error") {
            const errMsg =
              typeof event.data.message === "string"
                ? event.data.message
                : JSON.stringify(event.data);
            flushPending();
            emitEvent(
              `${config.productName} ${config.label}出错：${errMsg.slice(0, 200)}`,
              "error",
            );
            clearTimeout(lifetimeTimer);
            clearInterval(stallChecker);
            resolve({ status: "failed", finalText: errMsg });
            return;
          }

          if (event.event === "end") {
            break;
          }

          if (event.event === "updates" || event.event === "message") {
            const { nodeName, text } = extractText(event);
            if (text) {
              const nodeLabel = nodeName ? (NODE_LABELS[nodeName] ?? nodeName) : "";
              const prefix = nodeLabel ? `正在${nodeLabel}…` : "";
              pendingText += (prefix ? `\n${prefix}\n` : "") + text;
              finalText = text; // track the latest text as potential final output

              if (pendingText.length >= STREAM_SNIPPET_MAX_CHARS || pendingText.includes("\n\n")) {
                flushPending();
              } else {
                scheduleFlush();
              }
            }
          }
        }

        // Stream finished normally
        flushPending();
        if (!aborted) {
          const summary = finalText ? finalText.slice(0, 500) : "分析已完成";
          emitEvent(`${config.productName} ${config.label}完成：${summary}`, "done");
        }

        clearTimeout(lifetimeTimer);
        clearInterval(stallChecker);
        resolve({ status: "completed", finalText });
      } catch (err) {
        if (aborted) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        flushPending();
        emitEvent(`${config.productName} ${config.label}出错：${errMsg.slice(0, 200)}`, "error");
        clearTimeout(lifetimeTimer);
        clearInterval(stallChecker);
        resolve({ status: "failed", finalText: errMsg });
      }
    })();
  });

  return {
    done,
    abort() {
      aborted = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    },
  };
}
