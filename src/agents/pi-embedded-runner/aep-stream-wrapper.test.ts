import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAepHeadersWrapper } from "./aep-stream-wrapper.js";

// Minimal stubs — we only care about header injection, not Model shape.
const stubModel = { id: "gpt-4o" } as unknown as Parameters<StreamFn>[0];
const stubContext = {} as unknown as Parameters<StreamFn>[1];

describe("createAepHeadersWrapper", () => {
  const mockStreamFn = vi.fn();

  beforeEach(() => {
    mockStreamFn.mockReset();
    // Clear AEP env vars
    delete process.env.AEP_ENTITY;
    delete process.env.AEP_CLASSIFICATION;
    delete process.env.AEP_TRACE_ID;
    delete process.env.AEP_CONSENT;
    delete process.env.AEP_BUDGET;
  });

  it("passes through without headers when no AEP env vars set", () => {
    const wrapped = createAepHeadersWrapper(mockStreamFn);
    const options = { headers: { Authorization: "Bearer sk-test" } };

    void wrapped(stubModel, stubContext, options);

    expect(mockStreamFn).toHaveBeenCalledWith(stubModel, stubContext, options);
  });

  it("injects X-AEP-Entity header from env var", () => {
    process.env.AEP_ENTITY = "org:acme-corp";
    const wrapped = createAepHeadersWrapper(mockStreamFn);

    void wrapped(stubModel, stubContext, { headers: {} });

    const callArgs = mockStreamFn.mock.calls[0];
    expect(callArgs[2].headers["X-AEP-Entity"]).toBe("org:acme-corp");
  });

  it("injects all AEP headers when all env vars set", () => {
    process.env.AEP_ENTITY = "org:acme";
    process.env.AEP_CLASSIFICATION = "confidential";
    process.env.AEP_TRACE_ID = "trace-123";
    process.env.AEP_CONSENT = "analytics=true";
    process.env.AEP_BUDGET = "10.00";

    const wrapped = createAepHeadersWrapper(mockStreamFn);
    void wrapped(stubModel, stubContext, {});

    const callArgs = mockStreamFn.mock.calls[0];
    expect(callArgs[2].headers["X-AEP-Entity"]).toBe("org:acme");
    expect(callArgs[2].headers["X-AEP-Classification"]).toBe("confidential");
    expect(callArgs[2].headers["X-AEP-Trace-Id"]).toBe("trace-123");
    expect(callArgs[2].headers["X-AEP-Consent"]).toBe("analytics=true");
    expect(callArgs[2].headers["X-AEP-Budget"]).toBe("10.00");
  });

  it("preserves existing headers", () => {
    process.env.AEP_ENTITY = "org:test";
    const wrapped = createAepHeadersWrapper(mockStreamFn);
    const existingHeaders = { Authorization: "Bearer sk-test", "X-Custom": "value" };

    void wrapped(stubModel, stubContext, { headers: existingHeaders });

    const callArgs = mockStreamFn.mock.calls[0];
    expect(callArgs[2].headers.Authorization).toBe("Bearer sk-test");
    expect(callArgs[2].headers["X-Custom"]).toBe("value");
    expect(callArgs[2].headers["X-AEP-Entity"]).toBe("org:test");
  });

  it("uses streamSimple as default when no base function provided", () => {
    process.env.AEP_ENTITY = "org:test";
    const wrapped = createAepHeadersWrapper(undefined);
    // Should not throw
    expect(typeof wrapped).toBe("function");
  });
});
