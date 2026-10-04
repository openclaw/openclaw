import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserToolSchema, resolveBrowserToolCapabilities } from "./browser-tool.schema.js";
import {
  SECURE_INPUT_REDACTION_PLACEHOLDER,
  cancelSecureInputRequest,
  fulfillSecureInputRequest,
  readSecureInputLoginHint,
  redactSecureInputSnapshotResult,
  redactSecureInputToolPayload,
  resetSecureInputRegistryForTests,
  resolveSecureInputRequest,
  type DomFieldInspector,
  type SecureInputFieldRole,
  type SecureInputTabState,
} from "./browser-tool.secure-input.js";

function createInspectorFixture(overrides?: {
  tab?: Partial<SecureInputTabState>;
  candidates?: Array<{ domFieldId: string; role: SecureInputFieldRole }>;
  currentValues?: Record<string, string>;
}) {
  const tab: SecureInputTabState = {
    tabId: "tab-1",
    documentId: "doc-1",
    origin: "https://example.com",
    url: "https://example.com/login",
    ...overrides?.tab,
  };
  const currentValues = new Map(Object.entries(overrides?.currentValues ?? {}));
  const submit = vi.fn();
  const fillFields = vi.fn(async () => ({ filled: true }));
  const inspector: DomFieldInspector = {
    inspectFields: vi.fn(async () => ({
      tab,
      candidates: overrides?.candidates ?? [
        { domFieldId: "e1", role: "username" },
        { domFieldId: "e2", role: "password" },
      ],
    })),
    fillFields,
    readCurrentFieldValues: vi.fn(async ({ domFieldIds }) => {
      const values = new Map<string, string>();
      for (const domFieldId of domFieldIds) {
        const value = currentValues.get(domFieldId);
        if (value) {
          values.set(domFieldId, value);
        }
      }
      return values;
    }),
  };
  return {
    tab,
    inspector,
    fillFields,
    submit,
    setCurrentValue(domFieldId: string, value: string) {
      currentValues.set(domFieldId, value);
    },
  };
}

beforeEach(() => {
  resetSecureInputRegistryForTests();
});

describe("browser secure input schema", () => {
  it("stays opt-in and exposes only structural login hints", () => {
    const defaultCapabilities = resolveBrowserToolCapabilities();
    expect(defaultCapabilities.actions).not.toContain("requestSecureInput");

    const enabledCapabilities = resolveBrowserToolCapabilities({ secureInputEnabled: true });
    expect(enabledCapabilities.actions).toContain("requestSecureInput");

    const schema = createBrowserToolSchema(enabledCapabilities);
    expect(
      Value.Check(schema, {
        action: "requestSecureInput",
        targetId: "tab-1",
        loginHint: { fieldRoles: ["username", "password"] },
      }),
    ).toBe(true);
    expect(schema.properties).toHaveProperty("loginHint.properties.fieldRoles");
    const loginHint = schema.properties.loginHint as {
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
    };
    expect(loginHint.properties).not.toHaveProperty("selector");
    expect(loginHint.properties).not.toHaveProperty("origin");
    expect(loginHint.additionalProperties).toBe(false);
    expect(() =>
      readSecureInputLoginHint({
        loginHint: { fieldRoles: ["username"] },
        selector: "#username",
      }),
    ).toThrow("structural hints only");
    expect(() =>
      readSecureInputLoginHint({
        loginHint: { fieldRoles: ["username"] },
        origin: "https://example.com",
      }),
    ).toThrow("structural hints only");
  });
});

describe("browser secure input request lifecycle", () => {
  it("derives origin from the live tab rather than agent-supplied data", async () => {
    const fixture = createInspectorFixture({
      tab: {
        origin: "https://xn--pple-43d.example",
        url: "https://user:pass@Äpple.example/login",
      },
    });

    const request = await resolveSecureInputRequest(
      { tabId: "suggested-tab" },
      {
        fieldRoles: ["username"],
        // @ts-expect-error exercising hostile extra input
        origin: "https://phishing.test",
      },
      { inspector: fixture.inspector },
    );

    expect(request.origin).toBe("https://xn--pple-43d.example");
  });

  it("rejects a second pending request on the same tab", async () => {
    const fixture = createInspectorFixture();
    await resolveSecureInputRequest(
      { tabId: fixture.tab.tabId },
      { fieldRoles: ["username"] },
      { inspector: fixture.inspector },
    );

    await expect(
      resolveSecureInputRequest(
        { tabId: fixture.tab.tabId },
        { fieldRoles: ["password"] },
        { inspector: fixture.inspector },
      ),
    ).rejects.toThrow("already pending");
  });

  it("fails closed on changed document, changed origin, expiry, and reuse", async () => {
    const changedDoc = createInspectorFixture();
    const changedDocRequest = await resolveSecureInputRequest(
      { tabId: changedDoc.tab.tabId },
      { fieldRoles: ["username"] },
      { inspector: changedDoc.inspector, now: 1_000 },
    );
    await expect(
      fulfillSecureInputRequest(
        changedDocRequest.requestId,
        { [changedDocRequest.fields[0]!.fieldId]: "alice" },
        { ...changedDoc.tab, documentId: "doc-2" },
        { inspector: changedDoc.inspector, now: 2_000 },
      ),
    ).resolves.toEqual({ filled: false, reason: "page_changed" });

    const changedOrigin = createInspectorFixture();
    const changedOriginRequest = await resolveSecureInputRequest(
      { tabId: changedOrigin.tab.tabId },
      { fieldRoles: ["username"] },
      { inspector: changedOrigin.inspector, now: 1_000 },
    );
    await expect(
      fulfillSecureInputRequest(
        changedOriginRequest.requestId,
        { [changedOriginRequest.fields[0]!.fieldId]: "alice" },
        { ...changedOrigin.tab, origin: "https://evil.example" },
        { inspector: changedOrigin.inspector, now: 2_000 },
      ),
    ).resolves.toEqual({ filled: false, reason: "page_changed" });

    const expired = createInspectorFixture();
    const expiredRequest = await resolveSecureInputRequest(
      { tabId: expired.tab.tabId },
      { fieldRoles: ["password"] },
      { inspector: expired.inspector, now: 1_000, timeoutMs: 1_000 },
    );
    await expect(
      fulfillSecureInputRequest(
        expiredRequest.requestId,
        { [expiredRequest.fields[0]!.fieldId]: "secret" },
        expired.tab,
        { inspector: expired.inspector, now: 2_001 },
      ),
    ).resolves.toEqual({ filled: false, reason: "expired" });

    const success = createInspectorFixture();
    const successRequest = await resolveSecureInputRequest(
      { tabId: success.tab.tabId },
      { fieldRoles: ["username"] },
      { inspector: success.inspector },
    );
    await expect(
      fulfillSecureInputRequest(
        successRequest.requestId,
        { [successRequest.fields[0]!.fieldId]: "alice" },
        success.tab,
        { inspector: success.inspector },
      ),
    ).resolves.toEqual({ filled: true });
    await expect(
      fulfillSecureInputRequest(
        successRequest.requestId,
        { [successRequest.fields[0]!.fieldId]: "alice" },
        success.tab,
        { inspector: success.inspector },
      ),
    ).resolves.toEqual({ filled: false, reason: "not_found" });
  });

  it("fills without auto-submit and redacts later snapshot/text/console outputs by field identity", async () => {
    const fixture = createInspectorFixture({
      currentValues: {
        e1: "CANARY-SECRET-VALUE-12345",
        e2: "CANARY-SECRET-VALUE-12345",
      },
    });
    const request = await resolveSecureInputRequest(
      { tabId: fixture.tab.tabId },
      { fieldRoles: ["username", "password"] },
      { inspector: fixture.inspector },
    );

    const answers = Object.fromEntries(
      request.fields.map((field) => [field.fieldId, "CANARY-SECRET-VALUE-12345"]),
    );
    await expect(
      fulfillSecureInputRequest(request.requestId, answers, fixture.tab, {
        inspector: fixture.inspector,
      }),
    ).resolves.toEqual({ filled: true });
    expect(fixture.fillFields).toHaveBeenCalledTimes(1);
    expect(fixture.submit).not.toHaveBeenCalled();
    expect(Object.values(answers)).toEqual([]);

    const snapshot = await redactSecureInputSnapshotResult(
      {
        format: "aria",
        nodes: [
          {
            ref: "e1",
            role: "textbox",
            name: "Username",
            value: "CANARY-SECRET-VALUE-12345",
            depth: 0,
          },
          {
            ref: "e2",
            role: "textbox",
            name: "Password",
            value: "CANARY-SECRET-VALUE-12345",
            depth: 0,
          },
        ],
      },
      { tab: fixture.tab, inspector: fixture.inspector },
    );
    const textPayload = await redactSecureInputToolPayload(
      {
        text: "Visible text CANARY-SECRET-VALUE-12345",
        messages: [{ text: "console CANARY-SECRET-VALUE-12345" }],
      },
      { tab: fixture.tab, inspector: fixture.inspector },
    );

    const combined = JSON.stringify({ snapshot, textPayload });
    expect(combined).not.toContain("CANARY-SECRET-VALUE-12345");
    expect(combined).toContain(SECURE_INPUT_REDACTION_PLACEHOLDER);

    fixture.setCurrentValue("e1", "ROTATED-VALUE-999");
    const identityRedacted = await redactSecureInputToolPayload(
      {
        text: "Updated value ROTATED-VALUE-999",
        messages: [{ text: "console ROTATED-VALUE-999" }],
      },
      { tab: fixture.tab, inspector: fixture.inspector },
    );

    const identityCombined = JSON.stringify(identityRedacted);
    expect(identityCombined).not.toContain("CANARY-SECRET-VALUE-12345");
    expect(identityCombined).not.toContain("ROTATED-VALUE-999");
    expect(identityCombined).toContain(SECURE_INPUT_REDACTION_PLACEHOLDER);
  });

  it("consumes cancelled requests", async () => {
    const fixture = createInspectorFixture();
    const request = await resolveSecureInputRequest(
      { tabId: fixture.tab.tabId },
      { fieldRoles: ["otp"] },
      { inspector: fixture.inspector },
    );

    expect(cancelSecureInputRequest(request.requestId)).toBe(true);
    await expect(
      fulfillSecureInputRequest(
        request.requestId,
        { [request.fields[0]!.fieldId]: "123456" },
        fixture.tab,
        { inspector: fixture.inspector },
      ),
    ).resolves.toEqual({ filled: false, reason: "not_found" });
  });
});
