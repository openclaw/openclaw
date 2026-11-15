// Fixed focused selectors from run 43606084942; omitted shard siblings and parallel load are not reproduced.
import assert from "node:assert/strict";
export const sources = {
  baseline: "489774034984cd3ef78706125f20f4b25723288b",
  candidate: "8cb8b3e98da2980e1312480decf3079e0ddd0a0c",
};
export const originalTooling = "b27440329b4c450ec4c572e40ed338ed98f3d9c7";
export const plans = {
  state: {
    job: 132481409032,
    config: "test/vitest/vitest.gateway-server.config.ts",
    build: true,
    files: [
      "src/gateway/server.acp-native-model.product.test.ts",
      "src/gateway/server.beam-owned-view.test.ts",
      "src/gateway/server.board-named-query.session-scopes.test.ts",
      "src/gateway/server.catalog-startup.test.ts",
      "src/gateway/server.channels-start-outcomes.test.ts",
      "src/gateway/server.config-write-reread.test.ts",
      "src/gateway/server.required-placement-scopes.test.ts",
      "src/gateway/server.required-worker-profile.public.test.ts",
      "src/gateway/server.session-row-baselines.integration.test.ts",
    ],
    signatures: {
      "preserves ACP across native policy": {
        runtime: "node",
        pattern: /Test timed out in 120000ms/,
      },
      "keeps manual WebSocket calls within a session reader's approved named query": {
        runtime: "node",
        pattern: /Gateway plugin metadata is shutting down/,
      },
      "captures catalog before bootstrap (absent=false)": {
        runtime: "node",
        pattern: /Test timed out in 120000ms/,
      },
      "captures catalog before bootstrap (absent=true)": {
        runtime: "node",
        pattern: /Test timed out in 120000ms/,
      },
      "starts with provider settings without model rows when a channel is auto-enabled": {
        runtime: "node",
        pattern: /Gateway plugin metadata is shutting down/,
      },
      "starts config-backed accounts manually while breaker suppression remains active": {
        runtime: "node",
        pattern: /Gateway plugin metadata is shutting down/,
      },
      "reports skips and in-flight ownership while manual recovery bypasses the breaker": {
        runtime: "node",
        pattern: /Gateway plugin metadata is shutting down/,
      },
      "config.set settles when an external edit invalidates": {
        runtime: "node",
        pattern: /gateway request timeout for config[.]set/,
      },
      "required placement survives disconnect but stops setup when committed caller authority ends":
        { runtime: "node", pattern: /Gateway test RPC sessions[.]create: Error: timeout/ },
      "public required sessions.create publishes": {
        runtime: "node",
        pattern: /Gateway test RPC sessions[.]create: Error: timeout/,
      },
      "ordinary fact changes keep warm wire rows": {
        runtime: "node",
        pattern: /Gateway test RPC sessions[.]create: Error: timeout/,
      },
      "HTTP Visitor publications are privately readable": {
        runtime: "bun",
        pattern: /"code":"UNAVAILABLE".*Could not load this Beam/,
      },
      "preserves model admission and rolls back revoked owned Beam adoption": {
        runtime: "bun",
        pattern: /"code":"UNAVAILABLE".*Could not load this Beam/,
      },
    },
  },
  chat: {
    job: 132481406074,
    config: "test/vitest/vitest.gateway-server.config.ts",
    build: false,
    files: ["src/gateway/server.chat.gateway-server-chat-b.test.ts"],
    signatures: {
      "chat.startup returns transcript while metadata replacement is pending (profile=false delta=false thinking=undefined)":
        { runtime: "node", pattern: /expected \[\] to have a length of 1 but got \+0/ },
    },
  },
  reload: {
    job: 132481409054,
    config: "test/vitest/vitest.gateway-server.config.ts",
    build: false,
    files: ["src/gateway/server.plugin-reload-send-continuation.product.test.ts"],
    signatures: {
      "runs all three real reload continuations in a prebound owned process": {
        runtime: "bun",
        pattern: /Test timed out in 120000ms/,
      },
    },
  },
  startup: {
    job: 132481409138,
    config: "test/vitest/vitest.gateway-server.config.ts",
    build: false,
    files: [
      "src/gateway/server-startup-projection-warm.test.ts",
      "src/gateway/server-startup-resume.test.ts",
    ],
    signatures: {
      "keeps headless rows lazy and serves sessions.list (configured UI: true)": {
        runtime: "node",
        pattern: /gateway request timeout for sessions[.]list/,
      },
      "serves startup reads and unrelated turns while a resumed session retains input ordering": {
        runtime: "node",
        pattern: /gateway request timeout for sessions[.]github[.]options/,
      },
    },
  },
  compaction: {
    job: 132481420753,
    config: "test/vitest/vitest.infra.config.ts",
    build: true,
    files: ["src/agents/embedded-agent-runner/compact.foreground-resources.test.ts"],
    signatures: {
      "retains timeout resources through disposal without retaining write authority": {
        runtime: "node",
        pattern: /Compaction ended before the backend entered/,
      },
    },
  },
};
for (const plan of Object.values(plans)) {
  plan.required = Object.keys(plan.signatures);
}
export function classify(plan, report, exitCode, runtime = "node") {
  const tests = report.testResults.flatMap((suite) => suite.assertionResults);
  const executed = tests.filter((test) => ["passed", "failed"].includes(test.status));
  assert.ok(executed.length > 0, "selected zero tests");
  for (const name of plan.required) {
    assert.ok(
      executed.some((test) => test.fullName.includes(name)),
      "required case did not execute: " + name,
    );
  }
  const fileOrder = plan.files.map((file) => {
    const suite = report.testResults.find((entry) => entry.name.endsWith(file));
    assert.ok(
      suite?.assertionResults.some((test) => ["passed", "failed"].includes(test.status)),
      "selected file did not execute: " + file,
    );
    assert.ok(Number.isFinite(suite.startTime) && suite.startTime > 0, "missing file start time");
    return { file, startTime: suite.startTime };
  });
  assert.ok(
    fileOrder.every(
      (file, index) => index === 0 || file.startTime >= fileOrder[index - 1].startTime,
    ),
    "selected file order changed",
  );
  const failures = executed.filter((test) => test.status === "failed");
  assert.equal(exitCode === 0, failures.length === 0, "exit status and assertions disagree");
  return {
    outcome: failures.length === 0 ? "not-reproduced" : "failed",
    executed: executed.length,
    fileOrder,
    failures: failures.map((test) => ({
      name: test.fullName,
      messages: test.failureMessages,
      originalSignature: Object.entries(plan.signatures).some(
        ([name, expected]) =>
          test.fullName.includes(name) &&
          expected.runtime === runtime &&
          expected.pattern.test(test.failureMessages.join("\n")),
      ),
    })),
    tests: executed.map(({ fullName, status }) => ({ fullName, status })),
  };
}
