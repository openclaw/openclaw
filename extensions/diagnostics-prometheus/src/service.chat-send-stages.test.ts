import { expect, test } from "vitest";
import { baseEvent, createMetricsHarness, trusted, untrusted } from "./service.test-helpers.js";

test("exports chat.send request and startup histograms with bounded, trusted labels", () => {
  const metrics = createMetricsHarness();
  const event = {
    ...baseEvent(),
    type: "diagnostic.phase.completed" as const,
    name: "chat.send.snapshot",
    startedAt: 10,
    durationMs: 10,
    details: { stage: "request", privateText: "synthetic-private-content" },
  };
  try {
    metrics.record(event, trusted);
    metrics.record({ ...event, durationMs: 0 }, trusted);
    metrics.record({ ...event, durationMs: 3_000, details: { stage: "startup" } }, trusted);
    metrics.record(
      { ...event, name: "chat.send.replyInitialization", details: { stage: "startup" } },
      trusted,
    );
    const rendered = metrics.render();
    expect(rendered).toContain(
      'openclaw_chat_send_phase_seconds_count{phase="snapshot",stage="request"} 2\n',
    );
    expect(rendered).toContain(
      'openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="request"} 0.01\n',
    );
    expect(rendered).toContain(
      'openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="startup"} 3\n',
    );
    expect(rendered).toContain(
      'openclaw_chat_send_phase_seconds_count{phase="replyInitialization",stage="startup"} 1\n',
    );
    expect(rendered).not.toContain("synthetic-private-content");
    expect(rendered).not.toContain("privateText");

    metrics.record(event, untrusted);
    metrics.record({ ...event, name: "chat.send.private-session" }, trusted);
    metrics.record({ ...event, details: { stage: "private-session" } }, trusted);
    metrics.record({ ...event, details: undefined }, trusted);
    for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      metrics.record({ ...event, durationMs }, trusted);
    }
    expect(metrics.render()).toBe(rendered);
  } finally {
    metrics.stop();
  }
});
