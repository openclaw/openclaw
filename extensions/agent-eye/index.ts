// Agent Eye — Passive browser bug catcher for OpenClaw
// Zero booleans. All state uses typed string enums with explicit equality checks.

import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import {
  BugStore,
  BUG_SEVERITY,
  REPORT_VERDICT,
  EYE_MODE,
  classifySeverity,
  type BugSeverity,
  type BugReport,
  type EyeMode,
  type UserAction,
} from "./src/store.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const store = new BugStore();
let eyeMode: EyeMode = EYE_MODE.DORMANT;

// Rate limiter: max 30 reports per 60 seconds
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateBuckets: number[] = [];

function isRateLimited(): string {
  const now = Date.now();
  // Remove entries older than the window
  while (rateBuckets.length > 0 && rateBuckets[0]! < now - RATE_WINDOW_MS) {
    rateBuckets.shift();
  }
  if (rateBuckets.length >= RATE_MAX) return REPORT_VERDICT.RATE_LIMITED;
  rateBuckets.push(now);
  return REPORT_VERDICT.ACCEPTED;
}

// ---------------------------------------------------------------------------
// Helper — tool result wrapper
// ---------------------------------------------------------------------------

function json<T>(payload: T): { content: Array<{ type: "text"; text: string }>; details: T } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Helper — format bug for display
// ---------------------------------------------------------------------------

function formatBugSummary(bug: BugReport): string {
  const ts = new Date(bug.timestamp).toISOString().slice(11, 19);
  return `[${bug.severity}] ${ts} ${bug.trigger} — ${bug.message.slice(0, 120)}${bug.message.length > 120 ? "…" : ""}`;
}

function formatBugDetail(bug: BugReport): string {
  const lines = [
    `ID: ${bug.id}`,
    `Severity: ${bug.severity}`,
    `Trigger: ${bug.trigger}`,
    `URL: ${bug.url}`,
    `Time: ${new Date(bug.timestamp).toISOString()}`,
    `Message: ${bug.message}`,
  ];
  if (bug.filename) lines.push(`File: ${bug.filename}:${bug.line ?? "?"}:${bug.col ?? "?"}`);
  if (bug.stack) lines.push(`Stack:\n${bug.stack}`);
  if (bug.status !== undefined) lines.push(`HTTP Status: ${bug.status}`);
  if (bug.method) lines.push(`HTTP Method: ${bug.method}`);
  if (bug.viewport) lines.push(`Viewport: ${bug.viewport.width}x${bug.viewport.height}`);
  if (bug.tabTitle) lines.push(`Tab: ${bug.tabTitle}`);
  if (bug.domSnippet) lines.push(`DOM Context:\n${bug.domSnippet}`);
  if (bug.actions.length > 0) {
    lines.push(`\nAction Timeline (${bug.actions.length} actions):`);
    for (const action of bug.actions) {
      const t = new Date(action.timestamp).toISOString().slice(11, 19);
      lines.push(
        `  ${t} ${action.kind} ${action.selector}${action.text ? ` "${action.text}"` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function createBugsTool(): AnyAgentTool {
  return {
    name: "agent_eye_bugs",
    label: "Agent Eye Bugs",
    description:
      "List or inspect browser bugs captured by Agent Eye. " +
      "Without an ID, lists recent bugs (optionally filtered by severity: CRITICAL, ERROR, WARNING, INFO). " +
      "With an ID, returns full bug detail including the user action timeline.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Bug ID — returns full detail for a specific bug" }),
      ),
      severity: Type.Optional(
        Type.Union(
          [
            Type.Literal("CRITICAL"),
            Type.Literal("ERROR"),
            Type.Literal("WARNING"),
            Type.Literal("INFO"),
          ],
          { description: "Filter by severity level" },
        ),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max bugs to return (default 20)", minimum: 1, maximum: 200 }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (typeof params.id === "string") {
        const bug = store.get(params.id);
        if (bug === undefined) {
          return json({ found: "NOT_FOUND", id: params.id });
        }
        return json({ found: "FOUND", bug: formatBugDetail(bug) });
      }

      const severity = params.severity as BugSeverity | undefined;
      const bugs = store.list(severity);
      const limit = params.limit ?? 20;
      const sliced = bugs.slice(-limit);
      const summaries = sliced.map(formatBugSummary);

      return json({
        total: bugs.length,
        showing: sliced.length,
        filter: severity ?? "ALL",
        bugs: summaries,
        ids: sliced.map((b) => b.id),
      });
    },
  };
}

function createStatusTool(): AnyAgentTool {
  return {
    name: "agent_eye_status",
    label: "Agent Eye Status",
    description:
      "Show Agent Eye mode (WATCHING, DORMANT, PAUSED), bug counts by severity, and buffer capacity.",
    parameters: Type.Object({}),
    async execute() {
      const counts = store.counts();
      return json({
        mode: eyeMode,
        bufferUsed: store.size(),
        bufferCapacity: BugStore.capacity(),
        counts,
      });
    },
  };
}

function createClearTool(): AnyAgentTool {
  return {
    name: "agent_eye_clear",
    label: "Agent Eye Clear",
    description: "Clear all captured bugs from the Agent Eye buffer.",
    parameters: Type.Object({}),
    async execute() {
      const removed = store.clear();
      return json({ cleared: removed, verdict: "CLEARED" });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP Route handler — POST /agent-eye/report
// ---------------------------------------------------------------------------

function parseRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 256 * 1024; // 256 KB max
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function handleReport(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Only accept POST
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ verdict: REPORT_VERDICT.REJECTED, reason: "Method not allowed" }));
    return;
  }

  // Rate limit check
  const rateCheck = isRateLimited();
  if (rateCheck === REPORT_VERDICT.RATE_LIMITED) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ verdict: REPORT_VERDICT.RATE_LIMITED }));
    return;
  }

  let body: unknown;
  try {
    const raw = await parseRequestBody(req);
    body = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ verdict: REPORT_VERDICT.REJECTED, reason: "Invalid JSON" }));
    return;
  }

  if (typeof body !== "object" || body === null) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ verdict: REPORT_VERDICT.REJECTED, reason: "Expected object" }));
    return;
  }

  const payload = body as Record<string, unknown>;

  // Validate trigger
  const trigger = typeof payload.trigger === "string" ? payload.trigger : "";
  if (!store.isValidTrigger(trigger)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ verdict: REPORT_VERDICT.REJECTED, reason: `Unknown trigger: ${trigger}` }),
    );
    return;
  }

  // Extract fields
  const message = typeof payload.message === "string" ? payload.message : "Unknown error";
  const url = typeof payload.url === "string" ? payload.url : "";
  const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
  const status = typeof payload.status === "number" ? payload.status : undefined;
  const severity = classifySeverity(trigger, status);

  const actions: UserAction[] = [];
  if (Array.isArray(payload.actions)) {
    for (const a of payload.actions) {
      if (typeof a === "object" && a !== null) {
        const act = a as Record<string, unknown>;
        actions.push({
          kind: (typeof act.kind === "string" ? act.kind : "CLICK") as UserAction["kind"],
          selector: typeof act.selector === "string" ? act.selector : "",
          text: typeof act.text === "string" ? act.text : undefined,
          tag: typeof act.tag === "string" ? act.tag : undefined,
          x: typeof act.x === "number" ? act.x : undefined,
          y: typeof act.y === "number" ? act.y : undefined,
          url: typeof act.url === "string" ? act.url : undefined,
          timestamp: typeof act.timestamp === "number" ? act.timestamp : timestamp,
        });
      }
    }
  }

  const viewport =
    typeof payload.viewport === "object" && payload.viewport !== null
      ? {
          width:
            typeof (payload.viewport as Record<string, unknown>).width === "number"
              ? ((payload.viewport as Record<string, unknown>).width as number)
              : 0,
          height:
            typeof (payload.viewport as Record<string, unknown>).height === "number"
              ? ((payload.viewport as Record<string, unknown>).height as number)
              : 0,
        }
      : undefined;

  const id = store.add({
    url,
    timestamp,
    severity,
    trigger,
    message,
    stack: typeof payload.stack === "string" ? payload.stack : undefined,
    filename: typeof payload.filename === "string" ? payload.filename : undefined,
    line: typeof payload.line === "number" ? payload.line : undefined,
    col: typeof payload.col === "number" ? payload.col : undefined,
    status,
    method: typeof payload.method === "string" ? payload.method : undefined,
    actions,
    domSnippet: typeof payload.domSnippet === "string" ? payload.domSnippet : undefined,
    viewport,
    tabId: typeof payload.tabId === "number" ? payload.tabId : undefined,
    tabTitle: typeof payload.tabTitle === "string" ? payload.tabTitle : undefined,
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ verdict: REPORT_VERDICT.ACCEPTED, id, severity }));
}

// ---------------------------------------------------------------------------
// /eye command handler
// ---------------------------------------------------------------------------

function handleEyeCommand(args: string): { text: string } {
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  if (sub === "watch") {
    eyeMode = EYE_MODE.WATCHING;
    return { text: "Agent Eye mode set to WATCHING — capturing browser actions and errors." };
  }

  if (sub === "sleep") {
    eyeMode = EYE_MODE.DORMANT;
    return { text: "Agent Eye mode set to DORMANT — capture paused." };
  }

  if (sub === "bugs") {
    const bugs = store.list();
    if (bugs.length === 0) {
      return { text: "No bugs captured." };
    }
    const recent = bugs.slice(-10);
    const lines = recent.map(formatBugSummary);
    return { text: `Recent bugs (${recent.length} of ${bugs.length}):\n${lines.join("\n")}` };
  }

  if (sub === "clear") {
    const removed = store.clear();
    return { text: `Cleared ${removed} bug(s) from buffer.` };
  }

  if (sub === "status" || sub === "") {
    const counts = store.counts();
    const countStr = BugStore.severityOrder()
      .map((s) => `${s}: ${counts[s]}`)
      .join(", ");
    return {
      text: [
        `Mode: ${eyeMode}`,
        `Buffer: ${store.size()} / ${BugStore.capacity()}`,
        `Counts: ${countStr}`,
      ].join("\n"),
    };
  }

  return {
    text: [
      "Usage: /eye <subcommand>",
      "  watch  — start capturing (WATCHING mode)",
      "  sleep  — stop capturing (DORMANT mode)",
      "  bugs   — list recent bugs",
      "  clear  — clear bug buffer",
      "  status — show mode and stats",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default {
  id: "agent-eye",
  name: "Agent Eye",
  description:
    "Passive browser bug catcher. Watches user actions and auto-captures bugs with full action timelines.",

  register(api: OpenClawPluginApi) {
    // HTTP route for Chrome extension reports
    api.registerHttpRoute({
      path: "/agent-eye/report",
      handler: handleReport,
    });

    // Tools
    const toolFactory: OpenClawPluginToolFactory = (ctx) => {
      if (ctx.sandboxed === undefined)
        return [createBugsTool(), createStatusTool(), createClearTool()];
      return null;
    };
    api.registerTool(toolFactory, { optional: true });

    // /eye command
    api.registerCommand({
      name: "eye",
      description: "Agent Eye — browser bug catcher (watch, sleep, bugs, clear, status)",
      acceptsArgs: true,
      handler: async (ctx) => {
        const result = handleEyeCommand(ctx.args ?? "");
        return { text: result.text };
      },
    });
  },
};
