import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SystemAgentChatResultSchema } from "./schema/openclaw.js";
import type { WizardStep } from "./schema/wizard.js";

// Preserve wizard fields that the card-shaped `question` projection drops.
describe("SystemAgentChatResultSchema", () => {
  const validate = Compile(SystemAgentChatResultSchema);
  const base = { sessionId: "chat-1", reply: "Bot token", action: "none" };

  const steps: Array<{ name: string; step: Omit<WizardStep, "id" | "message"> }> = [
    {
      // Chat strips secret prefills; wizard.start/next may still carry them.
      name: "sensitive text carrying placeholder but no prefilled secret",
      step: {
        type: "text",
        placeholder: "123:abc",
        sensitive: true,
      },
    },
    {
      name: "non-sensitive text carrying a prefilled value",
      step: {
        type: "text",
        initialValue: "openclaw-bot",
      },
    },
    {
      name: "select with options",
      step: {
        type: "select",
        options: [
          { value: "alpha", label: "Alpha", hint: "First" },
          { value: "beta", label: "Beta" },
        ],
        initialValue: "beta",
      },
    },
    {
      name: "multiselect with options",
      step: {
        type: "multiselect",
        options: [
          { value: "alerts", label: "Alerts" },
          { value: "logs", label: "Logs" },
        ],
        initialValue: ["alerts"],
      },
    },
    {
      name: "confirm",
      step: { type: "confirm", initialValue: false },
    },
    {
      // Notes are auto-answered in chat, but still shipped by wizard methods.
      name: "note carrying a device code and an external URL",
      step: {
        type: "note",
        title: "Sign in",
        format: "plain",
        externalUrl: "https://example.com/auth",
        deviceCode: {
          code: "ABCD-EFGH",
          expiresInMinutes: 15,
          message: "Never share this code.",
        },
      },
    },
    {
      name: "progress",
      step: { type: "progress", executor: "gateway" },
    },
    {
      name: "action executed by the client",
      step: {
        type: "action",
        title: "Authorize",
        externalUrl: "https://example.com/authorize",
      },
    },
  ];

  it.each(steps)("accepts a chat result carrying a $name step", ({ step }) => {
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
