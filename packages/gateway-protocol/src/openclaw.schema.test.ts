import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SystemAgentChatResultSchema } from "./schema/openclaw.js";
import type { WizardStep } from "./schema/wizard.js";

// Preserve wizard fields that the card-shaped question projection drops.
describe("SystemAgentChatResultSchema", () => {
  const validate = Compile(SystemAgentChatResultSchema);
  const base = { sessionId: "chat-1", reply: "Bot token", action: "none" };
  const steps: Array<Omit<WizardStep, "id" | "message">> = [
    // Chat strips secret prefills; wizard.start/next may still carry them.
    { type: "text", placeholder: "123:abc", sensitive: true },
    { type: "text", initialValue: "openclaw-bot" },
    {
      type: "select",
      options: [
        { value: "alpha", label: "Alpha", hint: "First" },
        { value: "beta", label: "Beta" },
      ],
      initialValue: "beta",
    },
    {
      type: "multiselect",
      options: [
        { value: "alerts", label: "Alerts" },
        { value: "logs", label: "Logs" },
      ],
      initialValue: ["alerts"],
    },
    { type: "confirm", initialValue: false },
    // Notes are auto-answered in chat, but still shipped by wizard methods.
    {
      type: "note",
      title: "Sign in",
      format: "plain",
      externalUrl: "https://example.com/auth",
      deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 15, message: "Never share this code." },
    },
    { type: "progress", executor: "gateway" },
    { type: "action", title: "Authorize", externalUrl: "https://example.com/authorize" },
  ];
  it.each(steps)("accepts a $type step with initial value $initialValue", (step) => {
    const value = { id: "step", message: "Prompt", executor: "client", ...step };
    expect(validate.Check({ ...base, step: value })).toBe(true);
  });
  it("stays optional for replies with no awaited step", () => {
    expect(validate.Check(base)).toBe(true);
  });
  it("rejects a step outside the wizard step contract", () => {
    expect(validate.Check({ ...base, step: { id: "step-bogus", type: "freeform" } })).toBe(false);
  });
});
