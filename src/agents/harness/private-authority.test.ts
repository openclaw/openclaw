// Coverage for private lifecycle reset authority boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawAgentHarness } from "./builtin-openclaw.js";
import { harnessOwnsPrivateLifecycleResetAuthority } from "./private-authority.js";
import {
  clearAgentHarnesses,
  getRegisteredAgentHarness,
  registerAgentHarness,
} from "./registry.js";
import type { AgentHarness } from "./types.js";

function makeHarness(id: string): AgentHarness {
  return {
    id,
    label: id,
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  };
}

describe("harnessOwnsPrivateLifecycleResetAuthority", () => {
  afterEach(() => {
    clearAgentHarnesses();
  });

  it("accepts the branded built-in OpenClaw harness", () => {
    expect(harnessOwnsPrivateLifecycleResetAuthority(createOpenClawAgentHarness())).toBe(true);
  });

  it("rejects plugin harnesses that spoof the OpenClaw id", () => {
    const harness = makeHarness("openclaw");
    registerAgentHarness(harness, { ownerPluginId: "workspace-runtime" });

    expect(harnessOwnsPrivateLifecycleResetAuthority(harness)).toBe(false);
  });

  it.each(["codex", "copilot"] as const)(
    "accepts only the bundled %s-owned registered harness object",
    (id) => {
      const harness = makeHarness(id);
      registerAgentHarness(harness, { ownerPluginId: id });
      const registeredHarness = getRegisteredAgentHarness(id)?.harness;

      expect(registeredHarness).toBeDefined();
      expect(harnessOwnsPrivateLifecycleResetAuthority(registeredHarness as AgentHarness)).toBe(
        true,
      );
      expect(harnessOwnsPrivateLifecycleResetAuthority(harness)).toBe(false);
      expect(harnessOwnsPrivateLifecycleResetAuthority(makeHarness(id))).toBe(false);
    },
  );
});
