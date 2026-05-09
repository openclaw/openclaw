#!/usr/bin/env tsx
/**
 * Schema-half proof: ChatInjectParamsSchema accepts non-empty originAgent,
 * rejects empty/whitespace-only originAgent, and still rejects unknown
 * extra fields (additionalProperties:false invariant preserved).
 */

import { validateChatInjectParams } from "../src/gateway/protocol/index.js";

function show(label: string, params: unknown): void {
  const ok = validateChatInjectParams(params as never);
  const errs = (validateChatInjectParams as { errors?: Array<Record<string, unknown>> }).errors;
  console.log(`---`);
  console.log(`CASE     : ${label}`);
  console.log(`accepted : ${ok}`);
  if (!ok) {
    console.log(`errors   : ${JSON.stringify(errs)}`);
  }
}

console.log("ChatInjectParamsSchema validator behavior:");
console.log("");

show("legacy params (sessionKey + message + label)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  label: "proof",
});

show("patched params (with non-empty originAgent)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  label: "proof",
  originAgent: "hermes",
});

show("rejects empty-string originAgent (minLength:1)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  originAgent: "",
});

show("rejects unknown extra fields (additionalProperties:false preserved)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  somethingMadeUp: "should-fail",
});
