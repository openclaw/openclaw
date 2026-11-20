import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentProfile } from "../agent-profiles.js";
import { resolveContextSerialization } from "./resolve.js";

const auto: OpenClawConfig = { agents: { defaults: { agentProfileId: "auto" } } };

function resolve(config: OpenClawConfig = auto) {
  const resolvedProfile = resolveAgentProfile({
    config,
    agentId: "main",
    modelSizeClass: "small",
  });
  return resolveContextSerialization({ resolvedProfile });
}

describe("context serialization resolution", () => {
  it("uses the small profile compact mode for a small size class model", () => {
    expect(resolve()).toEqual({ mode: "compact", source: "agent-profile" });
  });

  it("keeps default serialization for a small size class model until size selection is on", () => {
    expect(resolve({})).toEqual({ mode: "default", source: "fallback" });
  });

  it("lets a pinned base profile keep the default mode on a small model", () => {
    expect(resolve({ agents: { defaults: { agentProfileId: "openclaw/base" } } })).toEqual({
      mode: "default",
      source: "fallback",
    });
  });
});
