import { WebClient } from "@slack/web-api";
import {
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type TraceEvent,
  type TraceNormalizer,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { expect } from "vitest";
import { markSlackStreamsStopped } from "./streaming.js";

export const SHORT_FINAL_TEXT = "All checks passed. Ship it.";
export const BLOCKS_FINAL_TEXT = "Release 2026.1.0 is ready to ship.";

// Portable presentation actions render as Block Kit with accessible fallback text.
export const BLOCKS_FINAL_PRESENTATION = {
  blocks: [
    {
      type: "buttons",
      buttons: [
        { label: "Approve release", action: { type: "callback", value: "approve-release" } },
        { label: "Release notes", url: "https://docs.openclaw.ai/release" },
      ],
    },
  ],
};

/** Canonicalizes Slack `sec.micro` timestamps to `ts#N` in first-seen order. */
export function createSlackTsNormalizer(): TraceNormalizer {
  const seen = new Map<string, string>();
  const canonicalize = (value: string) =>
    value.replace(/\b\d{10}\.\d{6}\b/g, (ts) => {
      let mapped = seen.get(ts);
      if (!mapped) {
        mapped = `ts#${seen.size + 1}`;
        seen.set(ts, mapped);
      }
      return mapped;
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return canonicalize(value);
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
  return (event: TraceEvent) =>
    event.data === undefined ? event : { ...event, data: walk(event.data) };
}

export function collectSlackWireTexts(events: readonly TraceEvent[]): string[] {
  const texts: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      texts.push(value);
    }
  };
  for (const event of events) {
    if (event.dir !== "out" || !event.data || typeof event.data !== "object") {
      continue;
    }
    const payload = (event.data as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as Record<string, unknown>;
    pushText(record.text);
    pushText(record.markdown_text);
    if (Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        if (chunk && typeof chunk === "object") {
          pushText((chunk as { text?: unknown }).text);
        }
      }
    }
  }
  return texts;
}

export function buildSlackDeliveryProofVerdict(params: {
  scenario: string;
  events: readonly TraceEvent[];
  headSha: string;
  expectedProse: string;
}): Record<string, unknown> {
  const wireTexts = collectSlackWireTexts(params.events);
  return {
    kind: "mock-gateway",
    liveSlack: false,
    harness: "extensions/slack/src/delivery-trace.test.ts",
    channel: "slack",
    scenario: params.scenario,
    headSha: params.headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "recording WebClient",
      provider: "scripted agent turn",
      delivery: "real dispatchPreparedSlackMessage + ChatStreamer/draft preview",
    },
    inboundPayloads: params.events
      .filter((event) => event.dir === "in" && (event.kind === "final" || event.kind === "partial"))
      .map((event) => event.data),
    deliveredWireTexts: wireTexts,
    execFailedDelivered: wireTexts.some((text) => text.includes("Exec failed")),
    proseDelivered: wireTexts.some((text) => text.includes(params.expectedProse)),
    outMethods: params.events.filter((event) => event.dir === "out").map((event) => event.kind),
  };
}

/** Exercises the real Slack dispatch and SDK stream lifecycle with recorded wire calls. */
export async function assertSlackSteeringTransportTrace(params: {
  stoppedBySlack: boolean;
  channelId: string;
  inboundTs: string;
  setup: (recorder: {
    recordWireCall: (call: { method: string; result?: unknown }) => void;
  }) => Promise<(step: DeliveryTraceInStep) => Promise<void>>;
  getClient: () => WebClient;
  assertNoRuntimeError: () => void;
}): Promise<void> {
  const { createSlackSystemEventTestHarness } =
    await import("./monitor/events/system-event-test-harness.js");
  const { registerSlackMessageEvents } = await import("./monitor/events/messages.js");
  const ingress = createSlackSystemEventTestHarness({ channelType: "channel" });
  registerSlackMessageEvents({ ctx: ingress.ctx, handleSlackMessage: async () => {} });
  const handleHumanMessage = ingress.getHandler("message");
  if (!handleHumanMessage) {
    throw new Error("expected registered Slack message ingress");
  }
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
          await handleHumanMessage({
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
  expect(starts[0]?.data).toMatchObject({ payload: { thread_ts: params.inboundTs } });
  expect(methods).not.toContain("chat.postMessage");
  if (params.stoppedBySlack) {
    expect(starts).toHaveLength(1);
    expect(methods).not.toContain("chat.stopStream");
    expect(collectSlackWireTexts(events).join("\n")).not.toContain("Final below");
  } else {
    expect(starts).toHaveLength(2);
    expect(starts[1]?.data).toMatchObject({ payload: { thread_ts: params.inboundTs } });
    expect(methods.indexOf("chat.stopStream")).toBeGreaterThan(methods.indexOf("chat.startStream"));
    expect(methods.indexOf("chat.stopStream")).toBeLessThan(
      methods.lastIndexOf("chat.startStream"),
    );
    expect(collectSlackWireTexts(events).join("\n")).toContain("Final below");
  }
  params.assertNoRuntimeError();
  if (process.env.OPENCLAW_DELIVERY_PROOF === "1") {
    process.stdout.write(
      `${JSON.stringify({ proof: "slack-top-level-steering", headSha: process.env.OPENCLAW_DELIVERY_PROOF_SHA, stoppedBySlack: params.stoppedBySlack, transport: "real dispatch and SDK ChatStreamer; recording WebClient", wireMethods: methods.filter((method) => method.startsWith("chat.")), wireTexts: collectSlackWireTexts(events) })}\n`,
    );
  }
}

/** Records the real SDK's serialized request, replacing only external HTTP. */
export function createSlackHttpRecorder(
  beforeResponse?: (method: string, body: URLSearchParams) => Promise<void>,
) {
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
      await beforeResponse?.(method, body);
      switch (method) {
        case "chat.postMessage":
        case "chat.update":
          return Response.json({
            ok: true,
            channel: body.get("channel"),
            ts,
            message: { ts, text: body.get("text") },
          });
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
  setup: (
    recorder: { recordWireCall: (call: { method: string; result?: unknown }) => void },
    client: WebClient,
  ) => Promise<(step: DeliveryTraceInStep) => Promise<void>>;
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
  emitSlackProgressHttpEvidence(`dispatch-${params.mode}`, http.requests);
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
  const first = writes.find(
    ({ method, body }) => method === "chat.postMessage" && readText(body).includes("FIRST"),
  );
  const second = writes.find(
    ({ method, body }) => method === "chat.update" && readText(body).includes("SECOND"),
  );
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second?.body.get("ts")).toBe(first?.ts);
  for (const request of [first, second]) {
    const text = readText(request!.body);
    expect(text).toContain(params.mode === "partial" ? native : escaped);
    expect(text).not.toContain("&amp;lt;");
    if (params.mode !== "partial") {
      for (const token of native.split(" ")) {
        expect(text).not.toContain(token);
      }
      for (const token of escaped.split(" ")) {
        expect(text.split(token)).toHaveLength(2);
      }
    }
    expect(text).toContain("<https://example.invalid/docs|Docs>");
    expect(text).toContain("`src/one.ts`");
    expect(text).not.toContain("**bold**");
    if (params.mode === "partial") {
      expect(text).toContain("*bold* _context_");
    } else {
      expect(text).toContain("_" + (request === first ? "FIRST" : "SECOND"));
    }
  }
  const final = writes.find(({ body }) => readText(body).includes("FINAL"));
  expect(final).toBeDefined();
  expect(readText(final!.body)).toContain(`FINAL ${native}`);
}

function emitSlackProgressHttpEvidence(
  scenario: string,
  requests: ReturnType<typeof createSlackHttpRecorder>["requests"],
) {
  if (process.env.OPENCLAW_DELIVERY_PROOF !== "1") {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      proofRecord: true,
      boundary: "real Slack SDK serialized HTTP request; external fetch fixture",
      scenario,
      sha: process.env.OPENCLAW_DELIVERY_PROOF_SHA,
      writes: requests
        .filter(({ method }) => method === "chat.postMessage" || method === "chat.update")
        .map(({ method, body, ts }) => ({
          method,
          ts,
          channel: body.get("channel"),
          text: body.get("text"),
          blocks: body.has("blocks") ? JSON.parse(body.get("blocks")!) : undefined,
        })),
    })}\n`,
  );
}
