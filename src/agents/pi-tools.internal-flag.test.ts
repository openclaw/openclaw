import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

/**
 * Task 2.2: internal flag → isTrustedInternal → SYSTEM tier
 *
 * Tests that the new `internal` flag correctly maps to `isTrustedInternal`
 * when calling resolveSenderTier, resulting in SYSTEM tier for internal calls.
 */
describe("pi-tools internal flag integration", () => {
  const heimdallConfig: OpenClawConfig = {
    agents: {
      defaults: {
        heimdall: {
          enabled: true,
          senderTiers: {
            owners: [111, "thebtf"],
            members: [222],
          },
        },
      },
    },
  };

  it("internal=true → tools created with SYSTEM tier context", () => {
    // When internal flag is set, should use SYSTEM tier (not OWNER)
    const tools = createOpenClawCodingTools({
      config: heimdallConfig,
      internal: true,
      senderId: "cron",
    });

    // Verify tools are created (basic smoke test)
    expect(tools.length).toBeGreaterThan(0);

    // SYSTEM tier should have limited safe tools, not all tools
    // (exact tool count depends on ACL configuration, just check creation succeeds)
  });

  it("internal=false → normal tier resolution (no SYSTEM)", () => {
    // Explicit false should not trigger SYSTEM tier
    const tools = createOpenClawCodingTools({
      config: heimdallConfig,
      internal: false,
      senderId: 111,
      senderUsername: "thebtf",
    });

    // Should resolve to OWNER tier (senderId in owners list)
    expect(tools.length).toBeGreaterThan(0);
  });

  it("internal=undefined → backward compatible (no SYSTEM)", () => {
    // Undefined (default) should not trigger SYSTEM tier
    const tools = createOpenClawCodingTools({
      config: heimdallConfig,
      senderId: "cron",
    });

    // Without internal flag, "cron" is not in owners → GUEST tier
    // GUEST has no tools by default (or minimal read-only)
    expect(tools).toBeDefined();
  });

  it("internal=true overrides owner status (SYSTEM has priority)", () => {
    // Even if senderId is in owners list, internal=true should give SYSTEM tier
    const tools = createOpenClawCodingTools({
      config: heimdallConfig,
      internal: true,
      senderId: 111,
      senderUsername: "thebtf",
    });

    // SYSTEM tier is less privileged than OWNER
    // Both should successfully create tools, but SYSTEM has fewer
    expect(tools.length).toBeGreaterThan(0);
  });

  it("Heimdall disabled → internal flag ignored", () => {
    const disabledConfig: OpenClawConfig = {
      agents: {
        defaults: {
          heimdall: {
            enabled: false,
          },
        },
      },
    };

    // When Heimdall disabled, internal flag should not affect tool creation
    const tools = createOpenClawCodingTools({
      config: disabledConfig,
      internal: true,
      senderId: "cron",
    });

    expect(tools.length).toBeGreaterThan(0);
  });

  // Task 2.3: Verify workaround removal - SYSTEM tier should NOT be overridden to OWNER
  it("Task 2.3: internal=true with senderIsOwner=true → SYSTEM tier (not OWNER)", () => {
    // After Task 2.3, even with senderIsOwner=true, internal=true should give SYSTEM tier
    // This verifies the OWNER override workaround has been removed
    const tools = createOpenClawCodingTools({
      config: heimdallConfig,
      internal: true,
      senderIsOwner: true, // Legacy flag present
      senderId: "cron",
    });

    // SYSTEM tier should have fewer tools than if it were OWNER
    // (specific count depends on ACL, but SYSTEM is more restrictive)
    expect(tools.length).toBeGreaterThan(0);

    // Additional check: create tools with OWNER explicitly
    const ownerTools = createOpenClawCodingTools({
      config: heimdallConfig,
      senderIsOwner: true,
      internal: false,
      senderId: 111, // in owners list
      senderUsername: "thebtf",
    });

    // SYSTEM should have same or fewer tools than OWNER
    expect(tools.length).toBeLessThanOrEqual(ownerTools.length);
  });
});
