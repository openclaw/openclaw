import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentRuntime } from "../../agent-runtime-id.js";

describe("resolveEmbeddedAgentRuntime", () => {
  it("uses OpenClaw mode by default", () => {
    expect(resolveEmbeddedAgentRuntime({})).toBe("openclaw");
  });

  it("accepts the OpenClaw runtime override", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "openclaw" })).toBe("openclaw");
  });

  it("canonicalizes legacy Codex app-server runtime ids", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex" })).toBe("codex");
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex-app-server" })).toBe(
      "codex",
    );
  });

  it("accepts auto mode", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "auto" })).toBe("auto");
  });

  it("preserves plugin harness runtime ids", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "custom-harness" })).toBe(
      "custom-harness",
    );
  });
});
