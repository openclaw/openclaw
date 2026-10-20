import { describe, expect, it } from "vitest";
import { baseEvent, createMetricsHarness, trusted, untrusted } from "./service.test-helpers.js";

describe("catalog list stage metrics", () => {
  it("exports elapsed and synchronous CPU populations with fixed labels and no diagnostic content", () => {
    const metrics = createMetricsHarness();
    const event = {
      ...baseEvent(),
      type: "diagnostic.phase.completed" as const,
      name: "sessions.catalog.list.planning",
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      details: { threadCpuMs: 2.5, privateText: "synthetic-private-content" },
    };
    try {
      metrics.record(event, trusted);
      metrics.record({ ...event, durationMs: 0, details: undefined }, trusted);
      for (const phase of ["projection_initial", "provider", "coalesced", "projection_final"]) {
        metrics.record({ ...event, name: `sessions.catalog.list.${phase}` }, trusted);
      }
      metrics.record({ ...event, name: "sessions.catalog.list.delivery" }, trusted);
      const rendered = metrics.render();
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="planning"} 2\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.01\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="planning"} 1\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_thread_cpu_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.0025\n',
      );
      const cpuLines = rendered
        .split("\n")
        .filter((line) => line.startsWith("openclaw_gateway_rpc_stage_thread_cpu_seconds"));
      expect(cpuLines.every((line) => /phase="(?:planning|delivery)"/.test(line))).toBe(true);
      expect(rendered).not.toContain("synthetic-private-content");
      expect(rendered).not.toContain("privateText");
      expect(metrics.render()).toBe(rendered);
    } finally {
      metrics.stop();
    }
  });

  it("rejects untrusted, unknown and malformed phase observations without creating series", () => {
    const metrics = createMetricsHarness();
    const event = {
      ...baseEvent(),
      type: "diagnostic.phase.completed" as const,
      name: "sessions.catalog.list.provider",
      startedAt: 10,
      durationMs: 10,
    };
    try {
      const before = metrics.render();
      metrics.record(event, untrusted);
      metrics.record(event, { trusted: false, internal: true });
      for (const name of [
        "startup.fixture",
        "sessions.catalog.list.private-session",
        "other.delivery",
      ]) {
        metrics.record({ ...event, name }, trusted);
      }
      for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        metrics.record({ ...event, durationMs }, trusted);
      }
      expect(metrics.render()).toBe(before);
      metrics.record(
        { ...event, name: "sessions.catalog.list.delivery", details: { threadCpuMs: "2.5" } },
        trusted,
      );
      expect(metrics.render()).toContain(
        'openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="delivery"} 1\n',
      );
      expect(metrics.render()).not.toContain("openclaw_gateway_rpc_stage_thread_cpu_seconds");
    } finally {
      metrics.stop();
    }
  });
});

it("exports chat.send startup and deferred histograms with bounded, trusted labels", () => {
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
    for (const stage of ["steer", "queued"]) {
      metrics.record(
        { ...event, name: "chat.send.dispatch", durationMs: 120_001, details: { stage } },
        trusted,
      );
    }
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
    for (const stage of ["steer", "queued"]) {
      expect(rendered).toContain(
        `openclaw_chat_send_phase_seconds_sum{phase="dispatch",stage="${stage}"} 120.001\n`,
      );
    }
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

it("bounds diff histograms to two methods, six stages and two cache outcomes in seconds", () => {
  const metrics = createMetricsHarness();
  const event = {
    type: "diagnostic.phase.completed" as const,
    name: "sessions.diff",
    startedAt: 0,
    durationMs: 160,
    details: {
      outcome: "cache-hit",
      admission: 1,
      "checkout-resolve": 2,
      "cache-validate": 150,
      "worker-queue": 100,
      "git-wall": 0,
      encode: 7,
      "/synthetic/private/checkout": 99,
      sessionKey: "synthetic-private-session",
    },
  };
  try {
    for (const name of ["sessions.diff", "checkout.diff"]) {
      for (const outcome of ["cache-hit", "cache-miss"]) {
        metrics.record({ ...event, name, details: { ...event.details, outcome } }, trusted);
      }
    }
    const rendered = metrics.render();
    const counts = rendered
      .split("\n")
      .filter((line) => line.startsWith("openclaw_diff_stage_seconds_count"));
    expect(counts).toHaveLength(24);
    expect(rendered).toContain(
      'openclaw_diff_stage_seconds_sum{method="sessions.diff",outcome="cache-hit",stage="cache-validate"} 0.15\n',
    );
    expect(rendered).toContain(
      'openclaw_diff_stage_seconds_sum{method="checkout.diff",outcome="cache-miss",stage="git-wall"} 0\n',
    );
    expect(rendered).not.toContain("synthetic");
    metrics.record(event, untrusted);
    metrics.record(event, { trusted: false, internal: true });
    metrics.record({ ...event, name: "sessions.diff.private" }, trusted);
    metrics.record({ ...event, details: { ...event.details, outcome: "private" } }, trusted);
    for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY, "150"]) {
      metrics.record(
        { ...event, details: { outcome: "cache-hit", "cache-validate": elapsed } },
        trusted,
      );
    }
    expect(metrics.render()).toBe(rendered);
  } finally {
    metrics.stop();
  }
});

it("bounds diff miss reasons without exporting revision keys or caller supplied labels", () => {
  const metrics = createMetricsHarness();
  const event = {
    type: "diagnostic.phase.completed" as const,
    name: "sessions.diff",
    startedAt: 0,
    durationMs: 1,
    details: { outcome: "cache-miss", missReason: "cold", revision: "private-revision" },
  };
  try {
    for (const name of ["sessions.diff", "checkout.diff"]) {
      for (const missReason of [
        "cold",
        "evicted",
        "pending",
        "no-revision",
        "oversized",
        "revision-changed-head",
        "revision-changed-index",
        "revision-changed-untracked-set",
        "revision-changed-worktree-mtime",
        "revision-changed-metadata",
      ]) {
        metrics.record({ ...event, name, details: { ...event.details, missReason } }, trusted);
      }
    }
    const rendered = metrics.render();
    const counters = rendered
      .split("\n")
      .filter((line) => line.startsWith("openclaw_diff_cache_misses_total{"));
    expect(counters).toHaveLength(20);
    expect(counters.every((line) => line.endsWith(" 1"))).toBe(true);
    expect(rendered).not.toContain("private");
    metrics.record(event, untrusted);
    metrics.record({ ...event, name: "sessions.diff.private" }, trusted);
    metrics.record({ ...event, details: { ...event.details, outcome: "cache-hit" } }, trusted);
    for (const missReason of ["private-revision", "revision-changed-/private/path", 1, true]) {
      metrics.record({ ...event, details: { ...event.details, missReason } }, trusted);
    }
    expect(metrics.render()).toBe(rendered);
  } finally {
    metrics.stop();
  }
});
