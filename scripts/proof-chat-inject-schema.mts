#!/usr/bin/env tsx
/**
 * Schema-half proof: ChatInjectParamsSchema accepts originAgent.
 *
 * Before patch: validateChatInjectParams({ ..., originAgent }) returns false
 *               with `additionalProperties` error from AJV.
 * After patch:  returns true.
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

show("patched params (with originAgent)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  label: "proof",
  originAgent: "hermes",
});

show("rejects unknown extra fields (additionalProperties:false preserved)", {
  sessionKey: "synthetic:fixture",
  message: "hello",
  somethingMadeUp: "should-fail",
});
