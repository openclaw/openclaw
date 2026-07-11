// Regression tests for sanitizeModelWarningValue's C1 boundary truncation,
// exercised through the exported resolveConfiguredModelRef warning path.
//
// A providerless model value that contains a residual C1 control byte (one that
// survives ANSI stripping, e.g. U+0080) must have the providerless-model
// warning truncated at that byte, so trailing attacker-controlled text after a
// C1 control cannot ride along into the logged warning.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: warnMock,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { resolveConfiguredModelRef } = await import("./model-selection-shared.js");

function warnFor(model: string): string {
  warnMock.mockClear();
  const cfg = { agents: { defaults: { model } } } as unknown as OpenClawConfig;
  const ref = resolveConfiguredModelRef({
    cfg,
    defaultProvider: "openai",
    defaultModel: "gpt-5",
  });
  // The resolved ref preserves the raw model; only the logged warning is sanitized.
  expect(ref).toEqual({ provider: "openai", model });
  return String(warnMock.mock.calls.at(-1)?.[0] ?? "");
}

describe("sanitizeModelWarningValue C1 boundary", () => {
  it("truncates the providerless-model warning at a residual C1 byte", () => {
    const PAD = String.fromCharCode(0x80); // C1 control that survives ANSI stripping
    const warn = warnFor(`gpt4${PAD}EVIL`);
    // Warning is truncated at the C1 boundary: the visible suffix is dropped.
    expect(warn).toContain('Model "gpt4" specified without provider');
    expect(warn).not.toContain("EVIL");
    expect(warn).not.toContain(PAD);
  });

  it("keeps a clean providerless-model value intact in the warning", () => {
    const warn = warnFor("gpt4");
    expect(warn).toContain('Model "gpt4" specified without provider');
  });
});
