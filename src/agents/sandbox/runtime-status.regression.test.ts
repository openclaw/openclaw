import { describe, expect, it } from "vitest";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

describe("resolveSandboxRuntimeStatus regression: #70342", () => {
  // Telegram DMs with dmScope="main" (default) previously resolved to the same
  // session key as the agent main session (agent:main:main). This caused the
  // sandbox gate to be bypassed for Telegram-routed direct chat because
  // shouldSandboxSession returned false when sessionKey === mainSessionKey,
  // even when mode was "all". The fix uses a dedicated "dm" bucket so Telegram
  // DMs always get their own sandbox context distinct from the main session.

  const sandboxModeAll = { agents: { defaults: { sandbox: { mode: "all" as const } } } };
  const sandboxModeNonMain = { agents: { defaults: { sandbox: { mode: "non-main" as const } } } };
  const sandboxModeOff = { agents: { defaults: { sandbox: { mode: "off" as const } } } };

  describe("Telegram DM session key (agent:main:dm) sandboxing", () => {
    it("mode=all: agent:main:dm IS sandboxed", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeAll,
        sessionKey: "agent:main:dm",
      });
      expect(result.sandboxed).toBe(true);
      expect(result.mode).toBe("all");
    });

    it("mode=non-main: agent:main:dm IS sandboxed (not the main session)", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeNonMain,
        sessionKey: "agent:main:dm",
      });
      expect(result.sandboxed).toBe(true);
      expect(result.mode).toBe("non-main");
    });

    it("mode=off: agent:main:dm is NOT sandboxed", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeOff,
        sessionKey: "agent:main:dm",
      });
      expect(result.sandboxed).toBe(false);
      expect(result.mode).toBe("off");
    });

    it("mode=all: agent:main:main IS sandboxed (main session with mode=all)", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeAll,
        sessionKey: "agent:main:main",
      });
      expect(result.sandboxed).toBe(true);
    });

    it("mode=non-main: agent:main:main is NOT sandboxed (main session excluded)", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeNonMain,
        sessionKey: "agent:main:main",
      });
      expect(result.sandboxed).toBe(false);
    });
  });

  describe("agent:main:dm is distinct from agent:main:main", () => {
    it("dm session key and main session key are different", () => {
      const dmResult = resolveSandboxRuntimeStatus({
        cfg: sandboxModeNonMain,
        sessionKey: "agent:main:dm",
      });
      const mainResult = resolveSandboxRuntimeStatus({
        cfg: sandboxModeNonMain,
        sessionKey: "agent:main:main",
      });
      // DM must be sandboxed; main must NOT be sandboxed for non-main mode
      expect(dmResult.sandboxed).toBe(true);
      expect(mainResult.sandboxed).toBe(false);
    });
  });

  describe("per-peer DM scope still works", () => {
    it("mode=non-main: agent:main:direct:<peerId> IS sandboxed", () => {
      const result = resolveSandboxRuntimeStatus({
        cfg: sandboxModeNonMain,
        sessionKey: "agent:main:direct:123456",
      });
      expect(result.sandboxed).toBe(true);
    });
  });
});
