import { WebClient } from "@slack/web-api";
import {
  runDeliveryTraceScenario,
  type TraceEvent,
  type TraceNormalizer,
  type WireRecorder,
  type DeliveryTraceDispatch,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect } from "vitest";
import { markSlackStreamsStopped } from "./streaming.js";

type Recorder = Pick<WireRecorder, "recordWireCall">;
type TraceSetup = (recorder: Recorder) => Promise<DeliveryTraceDispatch>;

export const SHORT_FINAL_TEXT = "All checks passed. Ship it.";
export const BLOCKS_FINAL_TEXT = "Release 2026.1.0 is ready to ship.";

const releaseButtons = [
  { label: "Approve release", action: { type: "callback", value: "approve-release" } },
  { label: "Release notes", url: "https://docs.openclaw.ai/release" },
];
export const BLOCKS_FINAL_PRESENTATION = {
  blocks: [{ type: "buttons", buttons: releaseButtons }],
};

/** Canonicalizes Slack `sec.micro` timestamps to `ts#N` in first-seen order. */
export function createSlackTsNormalizer(): TraceNormalizer {
  const seen = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\b\d{10}\.\d{6}\b/g, (ts) => {
        let mapped = seen.get(ts);
        if (!mapped) {
          mapped = `ts#${seen.size + 1}`;
          seen.set(ts, mapped);
        }
        return mapped;
      });
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return value;
  };
  return (event) => (event.data === undefined ? event : { ...event, data: walk(event.data) });
}

export function collectSlackWireTexts(events: readonly TraceEvent[]): string[] {
  return events.flatMap((event) => {
    const record = asOptionalRecord(asOptionalRecord(event.data)?.payload);
    if (event.dir !== "out" || !record) {
      return [];
    }
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    return [
      record.text,
      record.markdown_text,
      ...chunks.map((chunk: unknown) => asOptionalRecord(chunk)?.text),
    ].filter((text): text is string => typeof text === "string" && text.length > 0);
  });
}

export async function assertSlackSteeringTransportTrace(params: {
  stoppedBySlack: boolean;
  channelId: string;
  inboundTs: string;
  setup: TraceSetup;
  getClient: () => WebClient;
  assertNoRuntimeError: () => void;
}): Promise<void> {
  const { createSlackSystemEventTestHarness } =
    await import("./monitor/events/system-event-test-harness.js");
  const { registerSlackMessageEvents } = await import("./monitor/events/messages.js");
  const ingress = createSlackSystemEventTestHarness({ channelType: "channel" });
  registerSlackMessageEvents({ ctx: ingress.ctx, handleSlackMessage: async () => {} });
  const handleHumanMessage = ingress.getHandler("message");
  expect(handleHumanMessage).toBeDefined();
  let firstStreamTs: string | undefined;
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: params.stoppedBySlack ? "top-level-interruption-stop" : "top-level-interruption",
      steps: [
        { kind: "reply-start" },
        { kind: "tool-progress", name: "inspect", phase: "start" },
        { kind: "final", text: "Final below the later human message." },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const dispatch = await params.setup({
        recordWireCall: (call) => {
          if (call.method === "chat.startStream" && !firstStreamTs) {
            firstStreamTs = (call.result as { ts?: string })?.ts;
          }
          recorder.recordWireCall(call);
        },
      });
      return async (step) => {
        if (step.kind === "final") {
          expect(firstStreamTs).toBeDefined();
          await handleHumanMessage!({
            event: {
              type: "message",
              channel: params.channelId,
              channel_type: "channel",
              user: "U_SECOND",
              text: "Later human message",
              ts: "1767225602.000100",
            },
            body: { api_app_id: "A_TRACE" },
          });
          if (params.stoppedBySlack && firstStreamTs) {
            markSlackStreamsStopped(params.getClient(), params.channelId, [firstStreamTs]);
          }
        }
        await dispatch(step);
      };
    },
  });
  const out = events.filter((event) => event.dir === "out");
  const methods = out.map((event) => event.kind);
  const starts = out.filter((event) => event.kind === "chat.startStream");
  expect(starts).toHaveLength(params.stoppedBySlack ? 1 : 2);
  for (const { data } of starts) {
    expect(data).toMatchObject({ payload: { thread_ts: params.inboundTs } });
  }
  expect(methods).not.toContain("chat.postMessage");
  if (params.stoppedBySlack) {
    expect(methods).not.toContain("chat.stopStream");
    expect(collectSlackWireTexts(events).join("\n")).not.toContain("Final below");
  } else {
    expect(methods.indexOf("chat.stopStream")).toBeGreaterThan(methods.indexOf("chat.startStream"));
    expect(methods.indexOf("chat.stopStream")).toBeLessThan(
      methods.lastIndexOf("chat.startStream"),
    );
    expect(collectSlackWireTexts(events).join("\n")).toContain("Final below");
  }
  params.assertNoRuntimeError();
}

/** Records the real SDK's serialized request, replacing only external HTTP. */
function createSlackHttpRecorder() {
  const requests: Array<{ method: string; body: URLSearchParams; ts: string }> = [];
  let nextMessage = 0;
  const client = new WebClient("xoxb-synthetic-progress", {
    slackApiUrl: "https://slack-progress.invalid/api/",
    retryConfig: { retries: 0 },
    fetch: async (input, init) => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      if (typeof init?.body !== "string") {
        throw new Error("Expected URL-encoded Slack request");
      }
      const body = new URLSearchParams(init.body);
      const ts = body.get("ts") ?? `1767225601.${String(++nextMessage).padStart(6, "0")}`;
      requests.push({ method, body, ts });
      switch (method) {
        case "chat.postMessage":
        case "chat.update": {
          const message = { ts, text: body.get("text") };
          return Response.json({ ok: true, channel: body.get("channel"), ts, message });
        }
        case "users.info":
          return Response.json({ ok: true, user: { team_id: "T0TRACE" } });
        case "chat.delete":
        case "reactions.add":
        case "reactions.remove":
        case "assistant.threads.setStatus":
        case "assistant.threads.setTitle":
        case "assistant.threads.setSuggestedPrompts":
          return Response.json({ ok: true });
        default:
          throw new Error(`Unexpected Slack HTTP method: ${method}`);
      }
    },
  });
  return { client, requests };
}

export async function assertSlackProgressMentionHttpTrace(params: {
  mode: "compact" | "inferred-compact" | "partial" | "card";
  setup: (recorder: Recorder, client: WebClient) => ReturnType<TraceSetup>;
}) {
  const http = createSlackHttpRecorder();
  const native = "<@U0456EFGH> <#C0456EFGH> <!here>";
  const escaped = "&lt;@U0456EFGH&gt; &lt;#C0456EFGH&gt; &lt;!here&gt;";
  const source = `${native} with **bold** _context_ \`src/one.ts\` [Docs](https://example.invalid/docs)`;
  await runDeliveryTraceScenario({
    scenario: {
      name: `native-mentions-${params.mode}`,
      steps: [
        { kind: "reply-start" },
        { kind: "partial", text: `FIRST ${source}` },
        { kind: "advance", ms: 2000 },
        { kind: "tool-progress", name: "read", phase: "start" },
        { kind: "partial", text: `SECOND ${source}` },
        { kind: "advance", ms: 2000 },
        { kind: "final", text: `FINAL ${native}` },
        { kind: "idle" },
      ],
    },
    setup: (recorder) => params.setup(recorder, http.client),
  });
  const writes = http.requests.filter(({ method }) =>
    ["chat.postMessage", "chat.update"].includes(method),
  );
  const readText = (body: URLSearchParams): string => {
    const blocks = body.get("blocks");
    if (params.mode !== "card" || !blocks) {
      return body.get("text") ?? "";
    }
    const parsed = JSON.parse(blocks) as Array<{ text?: { text?: string } }>;
    return parsed.map((block) => block.text?.text ?? "").join("\n");
  };
  const findWrite = (api: string, marker: string) =>
    writes.find(({ method, body }) => method === api && readText(body).includes(marker));
  const first = findWrite("chat.postMessage", "FIRST");
  const second = findWrite("chat.update", "SECOND");
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second?.body.get("ts")).toBe(first?.ts);
  for (const request of [first, second]) {
    const text = readText(request!.body);
    const included = [
      params.mode === "partial" ? native : escaped,
      "<https://example.invalid/docs|Docs>",
      "`src/one.ts`",
      params.mode === "partial"
        ? "*bold* _context_"
        : "_" + (request === first ? "FIRST" : "SECOND"),
    ];
    const excluded = [
      "&amp;lt;",
      "**bold**",
      ...(params.mode === "partial" ? [] : native.split(" ")),
    ];
    expect(included.filter((token) => !text.includes(token))).toEqual([]);
    expect(excluded.filter((token) => text.includes(token))).toEqual([]);
    if (params.mode !== "partial") {
      for (const token of escaped.split(" ")) {
        expect(text.split(token)).toHaveLength(2);
      }
    }
  }
  const final = writes.find(({ body }) => readText(body).includes("FINAL"));
  expect(final).toBeDefined();
  expect(readText(final!.body)).toContain(`FINAL ${native}`);
}
