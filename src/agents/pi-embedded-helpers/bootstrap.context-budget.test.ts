import { describe, expect, it } from "vitest";
import { resolveBootstrapMaxChars, DEFAULT_BOOTSTRAP_MAX_CHARS } from "./bootstrap.js";

describe("resolveBootstrapMaxChars (contextBudget)", () => {
  it("uses configured bootstrapMaxChars when no budget enabled", () => {
    const cfg: any = { agents: { defaults: { bootstrapMaxChars: 1234 } } };
    expect(resolveBootstrapMaxChars(cfg)).toBe(1234);
  });

  it("caps bootstrapMaxChars when contextBudget is enabled", () => {
    const cfg: any = {
      agents: {
        defaults: {
          bootstrapMaxChars: 8000,
          contextBudget: { enabled: true, bootstrapMaxChars: 2000 },
        },
      },
    };
    expect(resolveBootstrapMaxChars(cfg)).toBe(2000);
  });

  it("does not change defaults when budget is disabled", () => {
    const cfg: any = {
      agents: {
        defaults: {
          contextBudget: { enabled: false, bootstrapMaxChars: 2000 },
        },
      },
    };
    expect(resolveBootstrapMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
});
