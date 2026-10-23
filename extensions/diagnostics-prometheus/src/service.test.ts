import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  expectMetrics,
  expectRecordedMetrics,
  expectExcludes,
  baseEvent,
  createMetricsHarness,
  scrapeMetrics,
  trusted,
  untrusted,
  withMetricsServer,
  type ExporterHealthReport,
  type TrustedExporterInternalDiagnostics,
} from "./service.test-helpers.js";

// HTTP scrapes here exercise an authorized operator; the exporter's scope guard is covered by
// service.http-scope.test.ts.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

const sessionList = {
  clientKind: "openclaw-control-ui",
  source: "wire",
  callerSource: "sidebar",
  rowMode: "sidebar",
  filter: "general",
} as const;

describe("diagnostics-prometheus service", () => {
  it("counts list callers separately while preserving method-only RPC totals", () => {
    using metrics = createMetricsHarness();
    for (const source of ["wire", "internal"] as const) {
      for (const caller of [
        {
          method: "models.list",
          modelsList: {
            clientKind: "openclaw-control-ui",
            source,
            view: "configured",
            scope: "agent",
            refresh: false,
            preparedOnly: true,
          },
        },
        { method: "sessions.list", sessionsList: { ...sessionList, source } },
        {
          method: "cron.list",
          cronList: {
            clientKind: "openclaw-control-ui",
            source,
            scope: "session",
            compact: true,
            page: "first",
          },
        },
      ] as const) {
        const event = { type: "gateway.rpc", phase: "received", ...caller } as const;
        metrics.record(event);
        if (source === "wire") {
          metrics.record(event);
          metrics.record(event, untrusted);
        }
      }
    }
    metrics.record({ type: "gateway.rpc", method: "health", phase: "received" });
    for (const clientKind of [
      "control-ui",
      "macos",
      "ios",
      "android",
      "cli",
      "node",
      "plugin",
    ] as const) {
      metrics.record({ type: "gateway.rpc", method: "health", phase: "received", clientKind });
    }
    const rendered = metrics.render();
    expectMetrics(rendered)(`openclaw_gateway_rpc_requests_total{method="models.list"} 3
openclaw_gateway_rpc_requests_total{method="health"} 8`);
    const clientSamples = rendered
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("openclaw_gateway_rpc_client_requests_total{") &&
          line.includes('method="health"'),
      );
    expect(clientSamples).toHaveLength(8);
    expectMetrics(
      clientSamples,
    )(`openclaw_gateway_rpc_client_requests_total{client_kind="other",method="health"} 1
openclaw_gateway_rpc_client_requests_total{client_kind="macos",method="health"} 1`);
    expectMetrics(rendered)(`openclaw_gateway_rpc_requests_total{method="sessions.list"} 3
openclaw_gateway_rpc_requests_total{method="cron.list"} 3
openclaw_cron_list_requests_total{client_kind="openclaw-control-ui",compact="true",page="first",scope="session",source="wire"} 2
openclaw_cron_list_requests_total{client_kind="openclaw-control-ui",compact="true",page="first",scope="session",source="internal"} 1
openclaw_sessions_list_requests_total{caller_source="sidebar",client_kind="openclaw-control-ui",filter="general",row_mode="sidebar",source="wire"} 2
openclaw_sessions_list_requests_total{caller_source="sidebar",client_kind="openclaw-control-ui",filter="general",row_mode="sidebar",source="internal"} 1
openclaw_models_list_requests_total{client_kind="openclaw-control-ui",prepared_only="true",refresh="false",scope="agent",source="wire",view="configured"} 2
openclaw_models_list_requests_total{client_kind="openclaw-control-ui",prepared_only="true",refresh="false",scope="agent",source="internal",view="configured"} 1`);
    expect(
      rendered
        .split("\n")
        .filter((line) => line.startsWith("openclaw_models_list_requests_total{")),
    ).toHaveLength(2);
  });

  it("counts egress outcomes and catalog preparation independently of log records", () => {
    using metrics = createMetricsHarness();
    for (const outcome of ["forwarded", "refused"] as const) {
      for (const substituted of [false, true]) {
        metrics.record({ type: "secret.egress", outcome, substituted });
        metrics.record({ type: "secret.egress", outcome, substituted }, untrusted);
        expect(metrics.render()).toContain(
          `openclaw_secret_egress_requests_total{outcome="${outcome}",substituted="${substituted}"} 1\n`,
        );
      }
    }
    const catalog = { type: "tool.catalog", source: "client", mode: "code-mode" } as const;
    metrics.record({ ...catalog, toolCount: 10 });
    metrics.record({ ...catalog, toolCount: 12 });
    metrics.record({ ...catalog, toolCount: 99 }, untrusted);
    expectMetrics(metrics.render())(`openclaw_tool_catalog_total{mode="code-mode",source="client"} 2
openclaw_tool_catalog_tools_total{mode="code-mode",source="client"} 22`);
  });

  it("distinguishes long runs through one hour without changing shorter-duration histograms", () => {
    using metrics = createMetricsHarness();
    for (const durationMs of [30_000, 120_000, 900_000, 1_800_000, 3_600_000, 3_600_001]) {
      const run = { runId: "long-run", provider: "test", model: "test-model", durationMs };
      metrics.record({ ...run, type: "run.completed", outcome: "completed" });
      metrics.record({
        ...run,
        type: "harness.run.completed",
        harnessId: "test",
        outcome: "completed",
      });
      metrics.record({
        ...run,
        type: "model.call.completed",
        callId: "test-call",
        observationUnit: "turn",
      });
      metrics.record({
        type: "message.dispatch.completed",
        source: "test",
        durationMs,
        outcome: "completed",
      });
      metrics.record({ type: "webhook.processed", channel: "telegram", durationMs });
    }
    const rendered = metrics.render();
    for (const name of ["run", "harness_run", "model_call", "message_dispatch"]) {
      const buckets = rendered
        .split("\n")
        .filter((line) => line.startsWith(`openclaw_${name}_duration_seconds_bucket{`))
        .map((line) => [line.match(/le="([^"]+)"/)?.[1], Number(line.split(" ").at(-1))]);
      expect(buckets).toEqual([
        ...["0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10"].map(
          (bound) => [bound, 0],
        ),
        ["30", 1],
        ["60", 1],
        ["120", 2],
        ["300", 2],
        ["600", 2],
        ["900", 3],
        ["1800", 4],
        ["3600", 5],
        ["+Inf", 6],
      ]);
    }
    expect(rendered).toContain(
      'openclaw_webhook_duration_seconds_bucket{channel="telegram",le="600",webhook="unknown"} 2\n',
    );
    expect(rendered).not.toMatch(
      /openclaw_webhook_duration_seconds_bucket\{[^}]*le="(?:900|1800|3600)"/,
    );
  });

  it("resolves RPC latency tails with bounded method-only scrape series", () => {
    using metrics = createMetricsHarness();
    const base = { type: "gateway.rpc" as const, method: "sessions.history" };
    for (const durationMs of [12, 24, 600, 1200, 2400, 4800, 9600, 24000, 30000, 600001]) {
      metrics.record({ ...base, phase: "response", outcome: "ok", durationMs });
      metrics.record({
        ...base,
        phase: "handler",
        outcome: "returned",
        durationMs,
        admissionMs: durationMs,
      });
      metrics.record({
        ...base,
        phase: "dispatch",
        outcome: "returned",
        durationMs,
        queueWaitMs: durationMs,
        response: "sent",
      });
    }
    const rendered = metrics.render();
    for (const timing of ["first_response", "handler", "admission", "queue_wait"]) {
      const name = `openclaw_gateway_rpc_${timing}_seconds`;
      const lines = rendered.split("\n").filter((line) => line.startsWith(`${name}_`));
      expect(lines).toHaveLength(44);
      for (const [bound, count] of [
        [0.01, 0],
        [0.0125, 1],
        [0.025, 2],
        [0.6, 3],
        [1.25, 4],
        [2.5, 5],
        [5, 6],
        [10, 7],
        [25, 8],
        [30, 9],
        [600, 9],
        ["+Inf", 10],
      ]) {
        expect(lines).toContain(`${name}_bucket{le="${bound}",method="sessions.history"} ${count}`);
      }
      expect(lines).toContain(`${name}_count{method="sessions.history"} 10`);
      const bounds = lines
        .filter((line) => line.startsWith(`${name}_bucket`))
        .map((line) => Number(line.match(/le="([^"]+)"/)?.[1]))
        .filter((bound) => bound >= 0.01 && bound <= 30);
      for (let index = 1; index < bounds.length; index += 1) {
        expect(bounds[index]! / bounds[index - 1]!).toBeLessThanOrEqual(4 / 3 + 1e-12);
      }
    }
  });

  it("counts HTTP cancellations by source without accepting public events", () => {
    using metrics = createMetricsHarness();
    for (const source of ["client", "client", "shutdown"] as const) {
      metrics.record(
        { type: "gateway.http.cancelled", source },
        { trusted: false, internal: true },
      );
    }
    metrics.record({ type: "gateway.http.cancelled", source: "client" }, untrusted);

    const rendered = metrics.render();
    expectMetrics(rendered)(`# TYPE openclaw_gateway_http_cancelled_total counter
openclaw_gateway_http_cancelled_total{source="client"} 2
openclaw_gateway_http_cancelled_total{source="shutdown"} 1`);
  });

  it("exports bounded byte histograms, including late frames and negative heap changes", () => {
    using metrics = createMetricsHarness();
    const base = { type: "gateway.rpc" as const, method: "sessions.history" };
    metrics.record({
      ...base,
      phase: "response",
      outcome: "ok",
      durationMs: 10,
      responseBytes: 1024,
      firstResponse: true,
    });
    metrics.record({
      ...base,
      phase: "response",
      outcome: "ok",
      durationMs: 20,
      responseBytes: 67108864,
      firstResponse: false,
    });
    for (const heapDeltaBytes of [-2048, 4096]) {
      metrics.record({
        ...base,
        phase: "handler",
        outcome: "returned",
        durationMs: 20,
        admissionMs: 0,
        heapDeltaBytes,
      });
    }
    metrics.record({
      ...base,
      phase: "handler",
      outcome: "returned",
      durationMs: 20,
      admissionMs: 0,
    });
    metrics.record({ ...base, phase: "response", outcome: "unavailable", durationMs: 20 });
    metrics.record(
      {
        ...base,
        method: "private-untrusted",
        phase: "response",
        outcome: "ok",
        durationMs: 20,
        responseBytes: 5000,
      },
      untrusted,
    );
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_gateway_rpc_handler_heap_delta_exclusive_total{method="sessions.history"} 2
openclaw_gateway_rpc_handler_seconds_count{method="sessions.history"} 3`);
    for (const [metric, sum, buckets] of [
      [
        "response",
        67109888,
        [
          [1024, 1],
          [67108864, 2],
          ["+Inf", 2],
        ],
      ],
      [
        "handler_heap_delta",
        2048,
        [
          [-1024, 1],
          [0, 1],
          [4096, 2],
          [67108864, 2],
          ["+Inf", 2],
        ],
      ],
    ] as const) {
      const name = `openclaw_gateway_rpc_${metric}_bytes`;
      expectMetrics(rendered)(`# TYPE ${name} histogram
${name}_sum{method="sessions.history"} ${sum}
${name}_count{method="sessions.history"} 2`);
      for (const [le, count] of buckets) {
        expect(rendered).toContain(`${name}_bucket{le="${le}",method="sessions.history"} ${count}`);
      }
    }
    expectMetrics(
      rendered,
    )(`openclaw_gateway_rpc_first_response_seconds_count{method="sessions.history"} 1
openclaw_gateway_rpc_outcomes_total{outcome="ok",phase="response"} 1`);
    expect(rendered).not.toContain("private-untrusted");
  });

  it("records hook-blocked run metrics with safe blocker originator only", () =>
    expectRecordedMetrics(
      [
        {
          type: "run.completed",
          runId: "run-should-not-export",
          sessionKey: "session-should-not-export",
          provider: "openai",
          model: "gpt-5.4",
          channel: "slack",
          trigger: "message",
          durationMs: 250,
          outcome: "blocked",
          blockedBy: "policy-plugin",
        },
      ],
      `openclaw_run_completed_total{blocked_by="policy-plugin",channel="slack",model="gpt-5.4",outcome="blocked",provider="openai",trigger="message"} 1`,
      ["run-should-not-export", "session-should-not-export", "matched secret prompt"],
    ));

  it("separates request and turn model-call metrics by observation unit", () => {
    using metrics = createMetricsHarness();

    metrics.record({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      transport: "http",
      durationMs: 250,
    });
    metrics.record({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      provider: "anthropic",
      model: "claude-opus-4-7",
      api: "claude-code",
      transport: "stdio-live",
      observationUnit: "turn",
      durationMs: 2500,
    });

    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_model_call_total{api="openai-responses",error_category="none",model="gpt-5.4",observation_unit="request",outcome="completed",provider="openai",transport="http"} 1
openclaw_model_call_duration_seconds_sum{api="claude-code",error_category="none",model="claude-opus-4-7",observation_unit="turn",outcome="completed",provider="anthropic",transport="stdio-live"} 2.5`);
  });

  it("records sanitized async diagnostic queue drop summaries from core diagnostics", () =>
    expectRecordedMetrics(
      [
        {
          type: "diagnostic.async_queue.dropped",
          droppedEvents: 3,
          droppedTrustedEvents: 1,
          droppedUntrustedEvents: 2,
          queueLength: 0,
          maxQueueLength: 10_000,
          drainBatchSize: 100,
        },
      ],
      `openclaw_diagnostic_async_queue_dropped_total{drop_class="total"} 3
openclaw_diagnostic_async_queue_dropped_total{drop_class="trusted"} 1
openclaw_diagnostic_async_queue_dropped_total{drop_class="untrusted"} 2
openclaw_diagnostic_async_queue_length 0`,
      [],
    ));

  it("redacts and bounds label values", () =>
    expectRecordedMetrics(
      [
        {
          type: "tool.execution.error",
          toolName: "shell\nbad",
          durationMs: 25,
          errorCategory: "Bearer sk-secret-token-value",
        },
      ],
      `openclaw_tool_execution_total{error_category="other",outcome="error",params_kind="unknown",tool="tool",tool_owner="none",tool_source="core"} 1`,
      ["Bearer", "sk-secret"],
    ));

  it("records operator-critical diagnostic signals missing from generic run metrics", () => {
    using metrics = createMetricsHarness();

    for (const event of [
      {
        ...baseEvent(),
        type: "tool.execution.blocked",
        toolName: "browser",
        toolSource: "mcp",
        toolOwner: "browser-tools",
        deniedReason: "tools.deny",
        reason: "matched browser",
        paramsSummary: { kind: "object" },
      },
      {
        ...baseEvent(),
        type: "model.failover",
        lane: "session:Agent:qa:otel-trace-smoke",
        fromProvider: "anthropic",
        fromModel: "claude-opus-4-6",
        toProvider: "openai",
        toModel: "gpt-5.4",
        reason: "overloaded",
        suspended: true,
      },
    ] satisfies DiagnosticEventPayload[]) {
      metrics.record(event);
    }
    for (const event of [
      {
        ...baseEvent(),
        type: "session.stuck",
        sessionId: "session-should-not-export",
        sessionKey: "key-should-not-export",
        state: "processing",
        ageMs: 12_000,
        classification: "stale_session_state",
        reason: "startup-sweep",
      },
      {
        ...baseEvent(),
        type: "payload.large",
        surface: "gateway.frame",
        action: "rejected",
        bytes: 2048,
        limitBytes: 1024,
        channel: "web",
        pluginId: "agent:qa:otel-trace-smoke",
        reason: "body-too-large",
      },
    ] satisfies DiagnosticEventPayload[]) {
      metrics.record(event);
    }
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_tool_execution_blocked_total{denied_reason="tools.deny",params_kind="object",tool="browser",tool_owner="browser-tools",tool_source="mcp"} 1
openclaw_model_failover_total{from_model="claude-opus-4-6",from_provider="anthropic",lane="session",reason="overloaded",suspended="true",to_model="gpt-5.4",to_provider="openai"} 1
openclaw_session_stuck_total{reason="startup-sweep",state="processing"} 1
openclaw_session_stuck_age_seconds_sum{reason="startup-sweep",state="processing"} 12
openclaw_payload_large_total{action="rejected",channel="web",plugin="none",reason="body-too-large",surface="gateway.frame"} 1
openclaw_payload_large_bytes_sum{action="rejected",channel="web",plugin="none",reason="body-too-large",surface="gateway.frame"} 2048`);
    expectExcludes(
      rendered,
      "session-should-not-export",
      "key-should-not-export",
      "Agent:qa:otel-trace-smoke",
    );
  });

  it("records webhook ingress and liveness warning metrics", () =>
    expectRecordedMetrics(
      [
        {
          type: "webhook.received",
          channel: "telegram",
          updateType: "message",
          chatId: "chat-should-not-export",
        },
        {
          type: "webhook.processed",
          channel: "telegram",
          updateType: "message",
          chatId: "chat-should-not-export",
          durationMs: 250,
        },
        {
          type: "webhook.error",
          channel: "telegram",
          updateType: "message",
          chatId: "chat-should-not-export",
          error: "Bearer sk-secret",
        },
        {
          type: "diagnostic.liveness.warning",
          reasons: ["event_loop_delay", "cpu"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 250,
          eventLoopDelayMaxMs: 900,
          eventLoopUtilization: 0.95,
          cpuCoreRatio: 1.4,
          active: 2,
          waiting: 1,
          queued: 4,
        },
      ],
      `openclaw_webhook_received_total{channel="telegram",webhook="message"} 1
openclaw_webhook_error_total{channel="telegram",webhook="message"} 1
openclaw_webhook_duration_seconds_sum{channel="telegram",webhook="message"} 0.25
openclaw_liveness_warning_total{reason="event_loop_delay:cpu"} 1
openclaw_liveness_sessions{state="active"} 2
openclaw_liveness_event_loop_delay_p99_seconds_sum{reason="event_loop_delay:cpu"} 0.25
openclaw_liveness_cpu_core_ratio_sum{reason="event_loop_delay:cpu"} 1.4`,
      ["chat-should-not-export", "sk-secret"],
    ));

  it("keeps only the bounded prefix from scoped queue lane labels", () =>
    expectRecordedMetrics(
      [
        {
          type: "queue.lane.enqueue",
          lane: "dreaming-narrative:session-main",
          queueSize: 2,
        },
      ],
      `openclaw_queue_lane_size{lane="dreaming-narrative"} 2`,
      ["session-main"],
    ));

  it("records skill usage metrics without raw paths or session identifiers", () =>
    expectRecordedMetrics(
      [
        {
          type: "skill.used",
          agentId: "main",
          runId: "run-should-not-export",
          sessionKey: "session-should-not-export",
          skillName: "tiny-llm-brainstorm",
          skillSource: "workspace",
          activation: "read",
          toolName: "read",
        },
      ],
      `# TYPE openclaw_skill_used_total counter
openclaw_skill_used_total{activation="read",agent="main",skill="tiny-llm-brainstorm",source="workspace"} 1`,
      ["run-should-not-export", "session-should-not-export", "SKILL.md"],
    ));

  it("bounds messaging labels without exporting raw chat identifiers", () => {
    using metrics = createMetricsHarness();

    metrics.record({
      type: "message.delivery.started",
      channel: "matrix",
      deliveryKind: "text",
      sessionKey: "session-should-not-export",
    });
    metrics.record({
      type: "message.processed",
      channel: "telegram/custom",
      chatId: "chat-should-not-export",
      messageId: "message-should-not-export",
      outcome: "completed",
      reason: "progress draft / message tool 123",
      durationMs: 25,
    });
    metrics.record({
      type: "message.delivery.error",
      channel: "discord/custom",
      deliveryKind: "progress draft" as never,
      durationMs: 50,
      errorCategory: "TimeoutError",
    });
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_message_delivery_started_total{channel="matrix",delivery_kind="text"} 1
openclaw_message_processed_total{channel="unknown",outcome="completed",reason="none"} 1
openclaw_message_delivery_total{channel="unknown",delivery_kind="other",error_category="TimeoutError",outcome="error"} 1`);
    expectExcludes(
      rendered,
      "chat-should-not-export",
      "message-should-not-export",
      "session-should-not-export",
      "progress draft",
    );
  });

  it("records inbound dispatch and session turn telemetry", () =>
    expectRecordedMetrics(
      [
        {
          type: "message.received",
          channel: "telegram",
          source: "webhook",
        },
        {
          type: "message.dispatch.started",
          channel: "telegram",
          source: "webhook",
        },
        {
          type: "message.dispatch.completed",
          channel: "telegram",
          source: "webhook",
          durationMs: 250,
          outcome: "completed",
        },
        {
          type: "message.dispatch.completed",
          channel: "telegram/custom",
          source: "webhook with secret sk-test",
          durationMs: 300,
          outcome: "completed",
          reason: "progress draft / message tool 123",
        },
        {
          type: "session.turn.created",
          runId: "run-should-not-export",
          agentId: "agent.default",
          channel: "telegram",
          trigger: "user",
        },
      ],
      `openclaw_message_received_total{channel="telegram",source="webhook"} 1
openclaw_message_dispatch_started_total{channel="telegram",source="webhook"} 1
openclaw_message_dispatch_completed_total{channel="telegram",outcome="completed",reason="none",source="webhook"} 1
openclaw_message_dispatch_duration_seconds_sum{channel="telegram",outcome="completed",reason="none",source="webhook"} 0.25
openclaw_message_dispatch_completed_total{channel="unknown",outcome="completed",reason="none",source="unknown"} 1
openclaw_message_dispatch_duration_seconds_sum{channel="unknown",outcome="completed",reason="none",source="unknown"} 0.3
openclaw_session_turn_created_total{agent="agent.default",channel="telegram",trigger="user"} 1`,
      ["run-should-not-export"],
    ));

  it("records session recovery and talk metrics without exporting raw ids or content", () => {
    using metrics = createMetricsHarness();

    metrics.record({
      type: "session.recovery.completed",
      sessionId: "session-should-not-export",
      sessionKey: "key-should-not-export",
      state: "processing",
      stateGeneration: 2,
      ageMs: 12_000,
      queueDepth: 1,
      reason: "startup-sweep",
      activeWorkKind: "tool_call",
      allowActiveAbort: true,
      status: "released",
      action: "abort-active-run",
    });
    metrics.record({
      type: "talk.event",
      sessionId: "talk-session-should-not-export",
      turnId: "turn-should-not-export",
      talkEventType: "input.audio.delta",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      byteLength: 320,
    });
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_session_recovery_total{action="abort-active-run",active_work_kind="tool_call",state="processing",status="released"} 1
openclaw_session_recovery_age_seconds_sum{action="abort-active-run",active_work_kind="tool_call",state="processing",status="released"} 12
openclaw_talk_event_total{brain="agent-consult",event_type="input.audio.delta",mode="realtime",provider="openai",transport="gateway-relay"} 1
openclaw_talk_audio_bytes_sum{brain="agent-consult",event_type="input.audio.delta",mode="realtime",provider="openai",transport="gateway-relay"} 320`);
    expectExcludes(
      rendered,
      "session-should-not-export",
      "key-should-not-export",
      "talk-session-should-not-export",
      "turn-should-not-export",
    );
  });

  it("subscribes to internal diagnostics and renders scrape text", () => {
    const listeners: Parameters<TrustedExporterInternalDiagnostics["onEvent"]>[0][] = [];
    const emitted: unknown[] = [];
    const healthReports: ExporterHealthReport[] = [];
    const error = vi.fn();
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();

    exporter.service.start({
      config: {} as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        debug: vi.fn(),
      },
      internalDiagnostics: {
        emit: (event) => emitted.push(event),
        onEvent: (listener) => {
          listeners.push(listener);
          return unsubscribe;
        },
        reportExporterHealth: (update) => {
          healthReports.push(update);
          throw new Error("private exporter health callback failure");
        },
      } as TrustedExporterInternalDiagnostics,
    });

    expect(listeners).toHaveLength(1);
    expectDefined(listeners[0], "Prometheus diagnostics listener")(
      {
        ...baseEvent(),
        type: "model.usage",
        agentId: "Agent:qa:otel-trace-smoke",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 12, output: 3, total: 15 },
      },
      trusted,
      {},
    );

    expect(emitted).toStrictEqual([
      {
        type: "telemetry.exporter",
        exporter: "diagnostics-prometheus",
        signal: "metrics",
        status: "started",
        reason: "configured",
      },
    ]);
    expect(healthReports).toStrictEqual([
      {
        signal: "metrics",
        transport: "prometheus-scrape",
        status: "started",
        reason: "configured",
      },
    ]);
    expect(scrapeMetrics(exporter.handler)).toContain(
      'openclaw_model_tokens_total{agent="unknown",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 12',
    );
    expect(scrapeMetrics(exporter.handler)).not.toContain("Agent:qa:otel-trace-smoke");

    const prefix = "x".repeat(499);
    const usage = {} as Extract<DiagnosticEventPayload, { type: "model.usage" }>["usage"];
    Object.defineProperty(usage, "input", {
      get() {
        throw new Error(`${prefix}😀`);
      },
    });
    expectDefined(listeners[0], "Prometheus diagnostics listener")(
      {
        ...baseEvent(),
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage,
      },
      trusted,
      {},
    );
    expect(error).toHaveBeenCalledWith(
      `diagnostics-prometheus: event handler failed (model.usage): ${prefix}`,
    );

    exporter.service.stop?.();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(emitted.at(-1)).toStrictEqual({
      type: "telemetry.exporter",
      exporter: "diagnostics-prometheus",
      signal: "metrics",
      status: "dropped",
    });
    expect(healthReports.at(-1)).toStrictEqual({
      signal: "metrics",
      transport: "prometheus-scrape",
      status: "dropped",
    });
    expect(scrapeMetrics(exporter.handler)).toBe("");
  });
});

describe("metrics HTTP handler", () => {
  it("sends byte-accurate representation metadata on HEAD", async () => {
    using metrics = createMetricsHarness();
    metrics.record({
      type: "run.completed",
      runId: "run-1",
      sessionKey: "session-1",
      provider: "openai",
      model: "synthetic-雪-🦞",
      channel: "discord",
      trigger: "message",
      durationMs: 1500,
      outcome: "completed",
    });
    await withMetricsServer(metrics, async (base) => {
      const get = await fetch(base);
      const getBody = await get.text();
      const head = await fetch(base, { method: "HEAD" });
      const headBody = await head.arrayBuffer();
      const getBodyBytes = Buffer.byteLength(getBody);
      expect(get.status).toBe(200);
      expect(getBodyBytes).toBeGreaterThan(0);
      expect(get.headers.get("content-length")).toBe(String(getBodyBytes));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(getBodyBytes));
      expect(headBody.byteLength).toBe(0);

      metrics.record({ type: "queue.lane.enqueue", lane: "main", queueSize: 2 });
      await fetch(base).then((res) => res.text());
      metrics.record({ type: "queue.lane.dequeue", lane: "main", queueSize: 0, waitMs: 10 });
      const updated = await fetch(base);
      const updatedBody = await updated.text();
      expect(updatedBody).toContain('openclaw_queue_lane_size{lane="main"} 0\n');
      expect(updatedBody).toContain(
        'openclaw_queue_lane_wait_seconds_bucket{lane="main",le="0.005"} 0\n',
      );
      expect(updated.headers.get("content-length")).toBe(String(Buffer.byteLength(updatedBody)));

      metrics.stop();
      metrics.start();
      metrics.record({ type: "webhook.received", channel: "test", updateType: "message" });
      const restarted = await fetch(base);
      const restartedBody = await restarted.text();
      expect(restartedBody).toBe(
        "# HELP openclaw_webhook_received_total Webhook requests received by channel and update type.\n" +
          "# TYPE openclaw_webhook_received_total counter\n" +
          'openclaw_webhook_received_total{channel="test",webhook="message"} 1\n',
      );
      expect(restarted.headers.get("content-length")).toBe(
        String(Buffer.byteLength(restartedBody)),
      );
    });
  });
});

describe("RPC attribution", () => {
  it("counts trusted baseline retirements and successful base misses with bounded labels", () => {
    using metrics = createMetricsHarness();
    for (const cause of [
      "projection-revision",
      "config",
      "identity",
      "selection-reset",
      "view-evicted",
      "history-evicted",
    ] as const) {
      const event = { type: "sessions.list.baseline.retired", cause } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_baseline_retirements_total{cause="${cause}"} 1\n`,
      );
    }
    for (const reason of ["unknown-base", "all-rows-changed"] as const) {
      const event = {
        type: "gateway.rpc",
        method: "sessions.list",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        sessionsList: {
          ...sessionList,
          rowsOutcome: "full-with-base",
          baseMissReason: reason,
        },
      } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      metrics.record({ ...event, firstResponse: false });
      metrics.record({ ...event, outcome: "unavailable" });
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_base_misses_total{reason="${reason}"} 1\n`,
      );
    }
  });

  it("accounts for session response bytes by sidebar row outcome", () => {
    using metrics = createMetricsHarness();
    for (const rowsOutcome of [
      "delta",
      "unchanged",
      "full-no-base",
      "full-with-base",
      "not-sidebar",
    ] as const) {
      const event = {
        type: "gateway.rpc",
        method: "sessions.list",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        responseBytes: 1234,
        sessionsList: {
          ...sessionList,
          rowMode: rowsOutcome === "not-sidebar" ? "compact" : "sidebar",
          rowsOutcome,
        },
      } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      metrics.record({ ...event, firstResponse: false, responseBytes: 42 });
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_response_bytes_total{caller_source="sidebar",client_kind="openclaw-control-ui",filter="general",row_mode="${event.sessionsList.rowMode}",rows_outcome="${rowsOutcome}",source="wire"} 1276\n`,
      );
    }
    expect(metrics.render()).toContain(
      'openclaw_gateway_rpc_response_bytes_sum{method="sessions.list"} 6380\n',
    );
  });

  it("accounts for chat history requests and bytes by bounded request and response shape", () => {
    using metrics = createMetricsHarness();
    for (const query of [
      { shape: "cursor", limitBucket: "<=20", outcome: "delta", source: "wire" },
      { shape: "older", limitBucket: "<=80", outcome: "page", source: "wire" },
      { shape: "receipt", limitBucket: "<=200", outcome: "reset", source: "internal" },
      { shape: "anchor", limitBucket: "<=200", outcome: "page", source: "wire" },
    ] as const) {
      const event = {
        type: "gateway.rpc",
        method: "chat.history",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        responseBytes: 1234,
        chatHistory: { clientKind: "openclaw-control-ui", ...query },
      } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      metrics.record({ ...event, firstResponse: false, responseBytes: 42 });
      const labels = `client_kind="openclaw-control-ui",limit_bucket="${query.limitBucket}",outcome="${query.outcome}",shape="${query.shape}",source="${query.source}"`;
      expect(metrics.render()).toContain(`openclaw_chat_history_requests_total{${labels}} 1\n`);
      expect(metrics.render()).toContain(
        `openclaw_chat_history_response_bytes_total{${labels}} 1276\n`,
      );
    }
    expect(metrics.render()).toContain(
      'openclaw_gateway_rpc_response_bytes_sum{method="chat.history"} 5104\n',
    );
  });
});
