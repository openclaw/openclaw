import { describe, expect, it } from "vitest";
import { resolveAcpAgent } from "./agent-resolution.js";

describe("resolveAcpAgent", () => {
  it("returns built-in acpx agent with matching logical and runtime IDs", () => {
    const result = resolveAcpAgent("codex", undefined, []);
    expect(result.logicalId).toBe("codex");
    expect(result.runtimeId).toBe("codex");
  });

  it("resolves fleet agent: logicalId preserves fleet ID, runtimeId maps to acpx name", () => {
    const result = resolveAcpAgent("ibo", undefined, [
      { id: "ibo", model: "openai-codex/gpt-5.3-codex" },
    ]);
    expect(result.logicalId).toBe("ibo");
    expect(result.runtimeId).toBe("codex");
  });

  it("uses defaultAgent fallback when requestedId is missing", () => {
    const result = resolveAcpAgent(undefined, "codex", []);
    expect(result.logicalId).toBe("codex");
    expect(result.runtimeId).toBe("codex");
  });

  it("throws clear error for unknown agent", () => {
    expect(() => resolveAcpAgent("xyz", undefined, [])).toThrow(
      'ACP agent "xyz" cannot be resolved to an acpx agent.',
    );
  });

  it("fleet agent lookup is case-insensitive", () => {
    const result = resolveAcpAgent("IBO", undefined, [
      { id: "ibo", model: "openai-codex/gpt-5.3-codex" },
    ]);
    expect(result.logicalId).toBe("ibo");
    expect(result.runtimeId).toBe("codex");
  });
});
