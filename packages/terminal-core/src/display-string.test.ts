import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { displayString } from "./display-string.js";

describe("displayString", () => {
  it("replaces exact home-prefixed paths", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");
    try {
      const home = path.resolve("/srv/openclaw-home");
      const input = `config: ${home}${path.sep}.openclaw${path.sep}openclaw.json`;
      const expected = `config: $OPENCLAW_HOME${path.sep}.openclaw${path.sep}openclaw.json`;
      expect(displayString(input)).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not replace home substring inside a different path segment", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");
    try {
      expect(displayString("/srv/openclaw-home-other/dir")).toBe("/srv/openclaw-home-other/dir");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not replace home substring preceded by a path separator inside another path", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");
    try {
      const home = path.resolve("/srv/openclaw-home");
      const input = `foo${path.sep}${home}${path.sep}.openclaw${path.sep}openclaw.json`;
      expect(displayString(input)).toBe(input);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
