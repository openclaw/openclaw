import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveMessagePrefix, resolveResponsePrefix } from "./identity.js";

describe("message prefix resolution", () => {
  it("returns configured messagePrefix override", () => {
    const cfg: ClawdbotConfig = {};
    expect(
      resolveMessagePrefix(cfg, "main", {
        configured: "[x]",
        hasAllowFrom: true,
      }),
    ).toBe("[x]");
    expect(
      resolveMessagePrefix(cfg, "main", {
        configured: "",
        hasAllowFrom: false,
      }),
    ).toBe("");
  });

  it("defaults messagePrefix based on allowFrom + identity", () => {
    const cfg: ClawdbotConfig = {
      agents: { list: [{ id: "main", identity: { name: "Richbot" } }] },
    };
    expect(resolveMessagePrefix(cfg, "main", { hasAllowFrom: true })).toBe("");
    expect(resolveMessagePrefix(cfg, "main", { hasAllowFrom: false })).toBe(
      "[Richbot]",
    );
  });

  it("falls back to [clawdbot] when identity is missing", () => {
    const cfg: ClawdbotConfig = {};
    expect(resolveMessagePrefix(cfg, "main", { hasAllowFrom: false })).toBe(
      "[clawdbot]",
    );
  });
});

describe("response prefix resolution", () => {
  it("does not apply any default when unset", () => {
    const cfg: ClawdbotConfig = {
      agents: { list: [{ id: "main", identity: { name: "Richbot" } }] },
    };
    expect(resolveResponsePrefix(cfg, "main")).toBeUndefined();
  });

  it("returns explicit responsePrefix when set", () => {
    const cfg: ClawdbotConfig = { messages: { responsePrefix: "PFX" } };
    expect(resolveResponsePrefix(cfg, "main")).toBe("PFX");
  });

  it("supports responsePrefix: auto (identity-derived opt-in)", () => {
    const withIdentity: ClawdbotConfig = {
      agents: { list: [{ id: "main", identity: { name: "Richbot" } }] },
      messages: { responsePrefix: "auto" },
    };
    expect(resolveResponsePrefix(withIdentity, "main")).toBe("[Richbot]");

    const withoutIdentity: ClawdbotConfig = {
      messages: { responsePrefix: "auto" },
    };
    expect(resolveResponsePrefix(withoutIdentity, "main")).toBeUndefined();
  });
});
