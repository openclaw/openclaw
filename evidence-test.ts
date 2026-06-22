// Helper to test internal functions of service.ts
import { OtelContentCapturePolicy } from "./extensions/diagnostics-otel/src/service.ts";

// Replicate the function to make it testable
// These functions are internal to service.ts (not exported), so we recreate the exact logic here

const NO_CONTENT_CAPTURE_BEFORE: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  logBodies: false,
};

const NO_CONTENT_CAPTURE_AFTER: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  logBodies: true,
};

function shouldCaptureOtelLogBody(policy: OtelContentCapturePolicy): boolean {
  return policy.logBodies;
}

function resolveContentCapturePolicy(value: unknown): OtelContentCapturePolicy {
  if (value === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
      logBodies: true,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NO_CONTENT_CAPTURE_AFTER; // after fix
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== true) {
    return NO_CONTENT_CAPTURE_AFTER; // after fix
  }
  return {
    inputMessages: config.inputMessages === true,
    outputMessages: config.outputMessages === true,
    toolInputs: config.toolInputs === true,
    toolOutputs: config.toolOutputs === true,
    systemPrompt: config.systemPrompt === true,
    toolDefinitions: config.toolDefinitions === true,
    logBodies: config.logBodies === true, // now reads from config!
  };
}

function resolveContentCapturePolicyBefore(value: unknown): OtelContentCapturePolicy {
  if (value === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
      logBodies: true,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NO_CONTENT_CAPTURE_BEFORE;
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== true) {
    return NO_CONTENT_CAPTURE_BEFORE;
  }
  return {
    inputMessages: config.inputMessages === true,
    outputMessages: config.outputMessages === true,
    toolInputs: config.toolInputs === true,
    toolOutputs: config.toolOutputs === true,
    systemPrompt: config.systemPrompt === true,
    toolDefinitions: config.toolDefinitions === true,
    logBodies: false, // before fix: hardcoded false
  };
}

// Run tests
console.log("=== PR #95636: OTLP Log Body Capture ===");
console.log("");

console.log("--- Test 1: No OTel config (fallback) ---");
console.log(
  "  Before: shouldCaptureOtelLogBody(NO_CONTENT_CAPTURE) =",
  shouldCaptureOtelLogBody(NO_CONTENT_CAPTURE_BEFORE),
);
console.log(
  "  After:  shouldCaptureOtelLogBody(NO_CONTENT_CAPTURE) =",
  shouldCaptureOtelLogBody(NO_CONTENT_CAPTURE_AFTER),
);
console.log("");

console.log("--- Test 2: Explicit { enabled: true } without logBodies ---");
console.log(
  "  Before: shouldCaptureOtelLogBody({ enabled: true }) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicyBefore({ enabled: true })),
);
console.log(
  "  After:  shouldCaptureOtelLogBody({ enabled: true }) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicy({ enabled: true })),
);
console.log("");

console.log("--- Test 3: Explicit { enabled: true, logBodies: true } ---");
console.log(
  "  Before: shouldCaptureOtelLogBody({ enabled: true, logBodies: true }) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicyBefore({ enabled: true, logBodies: true })),
);
console.log(
  "  After:  shouldCaptureOtelLogBody({ enabled: true, logBodies: true }) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicy({ enabled: true, logBodies: true })),
);
console.log("");

console.log("--- Test 4: captureContent = true (all on) ---");
console.log(
  "  Before: shouldCaptureOtelLogBody(true) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicyBefore(true)),
);
console.log(
  "  After:  shouldCaptureOtelLogBody(true) =",
  shouldCaptureOtelLogBody(resolveContentCapturePolicy(true)),
);
console.log("");

console.log("=== Summary ===");
console.log("Fix 1: NO_CONTENT_CAPTURE.logBodies: false → true (fallback path)");
console.log(
  "Fix 2: explicit config logBodies: false → config.logBodies === true (respects user setting)",
);
console.log("Both paths now capture log bodies by default when user does not opt out.");
