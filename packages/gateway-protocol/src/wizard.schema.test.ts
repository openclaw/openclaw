import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { WizardStepSchema } from "./schema/wizard.js";

describe("gateway protocol wizard schema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateWizardStep = ajv.compile(WizardStepSchema);

  it("accepts optional auth metadata on wizard text steps", () => {
    expect(
      validateWizardStep({
        id: "redirect-url",
        type: "text",
        message: "Paste the redirect URL here:",
        auth: {
          kind: "oauth-redirect",
          url: "https://auth.example.test/oauth/authorize?state=abc",
          provider: "openai-codex",
        },
        executor: "client",
      }),
    ).toBe(true);
  });

  it("rejects unknown wizard step and auth fields", () => {
    expect(
      validateWizardStep({
        id: "redirect-url",
        type: "text",
        message: "Paste the redirect URL here:",
        unexpected: true,
      }),
    ).toBe(false);

    expect(
      validateWizardStep({
        id: "redirect-url",
        type: "text",
        message: "Paste the redirect URL here:",
        auth: {
          kind: "oauth-redirect",
          url: "https://auth.example.test/oauth/authorize?state=abc",
          expectedInputOmit: true,
        },
      }),
    ).toBe(false);
  });

  it("rejects unknown auth kinds", () => {
    expect(
      validateWizardStep({
        id: "redirect-url",
        type: "text",
        message: "Paste the redirect URL here:",
        auth: {
          kind: "magic-link",
          url: "https://auth.example.test/oauth/authorize?state=abc",
        },
      }),
    ).toBe(false);
  });
});
