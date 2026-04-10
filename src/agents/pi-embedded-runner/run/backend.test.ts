import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentRuntime } from "../runtime.js";

describe("resolveEmbeddedAgentRuntime", () => {
  it("uses auto mode by default", () => {
    expect(resolveEmbeddedAgentRuntime({})).toBe("auto");
  });

  it("accepts the PI kill switch", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "pi" })).toBe("pi");
  });

  it("accepts codex app-server aliases", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex-app-server" })).toBe(
      "codex",
    );
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex" })).toBe("codex");
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "app-server" })).toBe("codex");
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
