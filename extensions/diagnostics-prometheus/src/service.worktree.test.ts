import { expect, it } from "vitest";
import { baseEvent, createMetricsHarness, trusted, untrusted } from "./service.test-helpers.js";

it("exports warm/cold preparation phases without identifiers or untrusted series", () => {
  const metrics = createMetricsHarness();
  const event = {
    ...baseEvent(),
    type: "diagnostic.phase.completed" as const,
    name: "worktree.preparation",
    startedAt: 100,
    durationMs: 1_200,
    details: {
      kind: "sandbox",
      template: "warm",
      outcome: "returned",
      allocate: 100,
      templateApply: 20,
      setup: 0,
      sessionKey: "synthetic-private-session",
    },
  };
  try {
    const before = metrics.render();
    metrics.record(event, untrusted);
    metrics.record(event, { trusted: false, internal: true });
    metrics.record({ ...event, details: { ...event.details, template: "private-key" } }, trusted);
    expect(metrics.render()).toBe(before);
    metrics.record(event, trusted);
    metrics.record(
      { ...event, details: { ...event.details, template: "cold", setup: 10_000 } },
      trusted,
    );
    const rendered = metrics.render();
    for (const [phase, sum] of [
      ["total", 1.2],
      ["allocate", 0.1],
      ["templateApply", 0.02],
      ["setup", 0],
    ] as const) {
      expect(rendered).toContain(
        `openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="${phase}",template="warm"} ${sum}\n`,
      );
    }
    expect(rendered).toContain(
      'openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="setup",template="cold"} 10\n',
    );
    expect(rendered).not.toContain("synthetic-private-session");
    expect(rendered).not.toContain("sessionKey");
    expect(rendered).not.toContain('phase="checkout"');
  } finally {
    metrics.stop();
  }
});
