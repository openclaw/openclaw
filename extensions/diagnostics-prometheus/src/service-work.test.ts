import { expect, it } from "vitest";
import {
  createMetricsHarness,
  type TrustedExporterInternalDiagnostics,
} from "./service.test-helpers.js";

it("replaces live owner counts through idle, source retirement, and exporter restart", () => {
  type Listener = Parameters<
    NonNullable<TrustedExporterInternalDiagnostics["onGatewayWorkMetrics"]>
  >[0];
  let snapshot: Parameters<Listener>[0] = {
    sessions: { running: 3, queued: 1 },
    work: { agentRuns: 4, chatRuns: 3, queuedTurns: 2 },
  };
  let listener: Listener | undefined;
  const metrics = createMetricsHarness(undefined, {}, (next) => {
    listener = next;
    next(snapshot);
    return () => {
      listener = undefined;
    };
  });
  const publish = (next: Parameters<Listener>[0]) => {
    snapshot = next;
    listener?.(next);
  };
  try {
    expect(metrics.render()).toContain('openclaw_sessions_active{state="running"} 3');
    expect(metrics.render()).toContain('openclaw_sessions_active{state="queued"} 1');
    expect(metrics.render()).toContain('openclaw_gateway_active_work{kind="agentRuns"} 4');
    expect(metrics.render()).toContain('openclaw_gateway_active_work{kind="chatRuns"} 3');
    expect(metrics.render()).toContain('openclaw_gateway_active_work{kind="queuedTurns"} 2');
    for (let index = 0; index < 60; index++) {
      metrics.record({ type: "session.state", state: "processing" });
    }
    publish({
      sessions: { running: 0, queued: 0 },
      work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
    });
    const idle = metrics.render();
    expect(idle).toContain('openclaw_session_state_total{reason="none",state="processing"} 60');
    expect(idle).toContain('openclaw_sessions_active{state="running"} 0');
    expect(idle).toContain('openclaw_sessions_active{state="queued"} 0');
    expect(idle).toContain('openclaw_gateway_active_work{kind="agentRuns"} 0');
    expect(idle).toContain('openclaw_gateway_active_work{kind="chatRuns"} 0');
    expect(idle).toContain('openclaw_gateway_active_work{kind="queuedTurns"} 0');
    expect(idle).toContain("# TYPE openclaw_sessions_active gauge");
    expect(idle).toContain("# TYPE openclaw_gateway_active_work gauge");
    publish(undefined);
    expect(metrics.render()).not.toContain("openclaw_sessions_active");
    expect(metrics.render()).not.toContain("openclaw_gateway_active_work");

    metrics.stop();
    expect(listener).toBeUndefined();
    publish({
      sessions: { running: 1, queued: 0 },
      work: { agentRuns: 1, chatRuns: 1, queuedTurns: 0 },
    });
    expect(metrics.render()).toBe("");
    metrics.start();
    expect(metrics.render()).toContain('openclaw_sessions_active{state="running"} 1');
    expect(metrics.render()).not.toContain("openclaw_session_state_total");
  } finally {
    metrics.stop();
  }
});
