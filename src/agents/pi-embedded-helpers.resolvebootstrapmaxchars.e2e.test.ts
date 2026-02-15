import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("resolveBootstrapMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapMaxChars()).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: 12345 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(12345);
  });
  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: -1 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
});

describe("resolveBootstrapTotalMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapTotalMaxChars()).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });
  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapTotalMaxChars: 12345 } },
    } as OpenClawConfig;
    expect(resolveBootstrapTotalMaxChars(cfg)).toBe(12345);
  });
  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapTotalMaxChars: -1 } },
    } as OpenClawConfig;
    expect(resolveBootstrapTotalMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });
});
