import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAckReaction } from "./identity.js";

describe("resolveAckReaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks a random emoji when configured with a list", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const cfg = {
      messages: { ackReaction: [" 👀 ", "✅"] },
    } satisfies OpenClawConfig;
    expect(resolveAckReaction(cfg, "main")).toBe("👀");
  });

  it("falls back to the agent identity emoji when unset", () => {
    const cfg = {
      agents: { list: [{ id: "alpha", identity: { emoji: "✨" } }] },
    } satisfies OpenClawConfig;
    expect(resolveAckReaction(cfg, "alpha")).toBe("✨");
  });

  it("defaults to 👀 when nothing else is configured", () => {
    const cfg = {} satisfies OpenClawConfig;
    expect(resolveAckReaction(cfg, "main")).toBe("👀");
  });

  it("treats empty values as disabled", () => {
    const cfg = {
      messages: { ackReaction: [" ", ""] },
    } satisfies OpenClawConfig;
    expect(resolveAckReaction(cfg, "main")).toBe("");
  });
});
