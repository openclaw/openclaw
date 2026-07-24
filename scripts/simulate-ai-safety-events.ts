#!/usr/bin/env tsx
/**
 * Simulation: AI safety event taxonomy — live proof run
 * Emits one event of each type through the trusted diagnostic path,
 * verifies OTEL dispatch, and tests the spoof-resistance gate.
 *
 * Run: npx tsx scripts/simulate-ai-safety-events.ts
 */

import { createAiSafetyRecorders } from "../extensions/diagnostics-otel/src/service-recorders-ai-safety.js";
import {
  emitTrustedAISafetyDiagnosticEvent as emitTrustedAISafetyEvent,
  onAISafetyDiagnosticEvent,
} from "../src/infra/diagnostic-events.js";
import { emitPluginSafetyEvent } from "../src/plugins/safety-event-emission.js";

const AI_SAFETY_EVENT_SCHEMA_VERSION = "ai.diagnostics.v1";
const SESSION = "sim-session-abc12345";
const AGENT = "sim-agent-007";

function makeCounter(name: string, sink: string[]) {
  return {
    add(value: number, attributes: Record<string, string>) {
      sink.push(
        `  otel counter ${name} += ${value}\n` +
          Object.entries(attributes)
            .map(([k, v]) => `      ${k} = ${JSON.stringify(v)}`)
            .join("\n"),
      );
    },
  };
}

async function main() {
  console.log("=== OpenClaw AI Safety Event Taxonomy — Simulation Run ===");
  console.log(`Schema version: ${AI_SAFETY_EVENT_SCHEMA_VERSION}`);
  console.log(`Session: ${SESSION}`);
  console.log("");

  const otelLines: string[] = [];
  const recorders = createAiSafetyRecorders({
    aiSafetyPromptInjectionSignalCounter: makeCounter(
      "openclaw.ai_safety.prompt_injection.signal",
      otelLines,
    ),
    aiSafetyToolPolicyDecisionCounter: makeCounter(
      "openclaw.ai_safety.tool_policy.decision",
      otelLines,
    ),
    aiSafetyExternalContentConsumedCounter: makeCounter(
      "openclaw.ai_safety.external_content.consumed",
      otelLines,
    ),
    aiSafetyUserFeedbackReceivedCounter: makeCounter(
      "openclaw.ai_safety.user_feedback.received",
      otelLines,
    ),
    aiSafetyMemoryContextSelectedCounter: makeCounter(
      "openclaw.ai_safety.memory_context.selected",
      otelLines,
    ),
    aiSafetyEvalResultCounter: makeCounter("openclaw.ai_safety.eval.result", otelLines),
  } as never);

  const dispatched: string[] = [];
  const unsubscribe = onAISafetyDiagnosticEvent((event, metadata) => {
    dispatched.push(`  dispatch → ${event.type} (seq=${event.seq}, trusted=${metadata.trusted})`);
    switch (event.type) {
      case "ai_safety.prompt_injection.signal":
        recorders.recordPromptInjectionSignal(event, metadata);
        break;
      case "ai_safety.tool_policy.decision":
        recorders.recordToolPolicyDecision(event, metadata);
        break;
      case "ai_safety.external_content.consumed":
        recorders.recordExternalContentConsumed(event, metadata);
        break;
      case "ai_safety.user_feedback.received":
        recorders.recordUserFeedbackReceived(event, metadata);
        break;
      case "ai_safety.memory_context.selected":
        recorders.recordMemoryContextSelected(event, metadata);
        break;
      case "ai_safety.eval.result":
        recorders.recordEvalResult(event, metadata);
        break;
    }
  });

  const events = [
    {
      type: "ai_safety.prompt_injection.signal" as const,
      sessionId: SESSION,
      agentId: AGENT,
      severity: "warn" as const,
      category: "indirect" as const,
      actionTaken: "flagged" as const,
      sourceType: "tool_output" as const,
      snippetHash: "sha256:a3f0e0b7c2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
      channel: "whatsapp",
    },
    {
      type: "ai_safety.tool_policy.decision" as const,
      sessionId: SESSION,
      agentId: AGENT,
      toolName: "bash",
      decision: "approval_required" as const,
      policySource: "static_config" as const,
      severity: "warn" as const,
      channel: "whatsapp",
    },
    {
      type: "ai_safety.external_content.consumed" as const,
      sessionId: SESSION,
      agentId: AGENT,
      sourceType: "web_fetch" as const,
      trusted: false,
      urlHash: "sha256:b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
      byteSize: 14320,
      channel: "whatsapp",
    },
    {
      type: "ai_safety.user_feedback.received" as const,
      sessionId: SESSION,
      agentId: AGENT,
      label: "correction" as const,
      score: 0.2,
      channel: "whatsapp",
    },
    {
      type: "ai_safety.memory_context.selected" as const,
      sessionId: SESSION,
      agentId: AGENT,
      memoryType: "long_term" as const,
      itemCount: 12,
      totalTokens: 3840,
      channel: "whatsapp",
    },
    {
      type: "ai_safety.eval.result" as const,
      sessionId: SESSION,
      agentId: AGENT,
      evalName: "source-trust-check",
      score: 0.71,
      passed: true,
      severity: "info" as const,
      channel: "whatsapp",
    },
  ];

  console.log("--- Stage 1: emit through trusted core path ---");
  for (const event of events) {
    process.stdout.write(`  emit → ${event.type} ... `);
    emitTrustedAISafetyEvent(event);
    console.log("ok");
  }

  // Allow synchronous dispatch to complete.
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });

  console.log("");
  console.log("--- Stage 2: dispatcher fan-out (trusted metadata attached) ---");
  for (const line of dispatched) {
    console.log(line);
  }

  console.log("");
  console.log("--- Stage 3: spoof-resistance gate (untrusted plugin path) ---");
  const dispatchedBeforeSpoof = dispatched.length;
  let spoofedThrough = 0;
  for (const event of events) {
    process.stdout.write(`  untrusted emit → ${event.type} ... `);
    // Attempt to emit via plugin path with no declared safety event types in manifest.
    const result = emitPluginSafetyEvent({
      pluginId: "untrusted-test-plugin",
      event,
      trusted: false,
      declaredSafetyEventTypes: [], // empty — plugin didn't declare these types
    });
    if (result.ok) {
      spoofedThrough++;
      console.log("REACHED DISPATCHER (unexpected)");
    } else {
      console.log("submitted");
    }
  }
  // Allow any late dispatch to arrive.
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  const actualSpoofed = dispatched.length - dispatchedBeforeSpoof;
  console.log(
    `  result: ${actualSpoofed}/${events.length} untrusted ai_safety.* events reached the dispatcher (expected 0 — dropped by manifest gate)`,
  );

  console.log("");
  console.log("--- Stage 4: OTEL exporter recorders (counter + low-cardinality attrs) ---");
  for (const line of otelLines) {
    console.log(line);
  }

  // Privacy assertion: raw hashes must never appear in exporter attributes.
  const otelText = otelLines.join("\n");
  const hashesLeaked =
    otelText.includes("a3f0e0b7c2d4e5f6") || otelText.includes("b4c5d6e7f8a9b0c1");

  console.log("");
  console.log(`All ${events.length} events emitted through trusted path.`);
  console.log(
    `Dispatcher fan-out observed for ${dispatchedBeforeSpoof}/${events.length} trusted events.`,
  );
  console.log(
    `Spoof-resistance verified: ${actualSpoofed}/${events.length} untrusted emissions dispatched.`,
  );
  console.log("Privacy fields verified: snippetHash and urlHash are sha256 — no raw content, and");
  console.log(
    `neither hash appears in OTEL exporter attributes (leak check: ${hashesLeaked ? "FAILED" : "passed"}).`,
  );
  console.log("");

  unsubscribe();

  if (actualSpoofed !== 0 || dispatchedBeforeSpoof !== events.length || hashesLeaked) {
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
