import { describe, expect, it } from "vitest";
import { resolveAcpAgent } from "./agent-resolution.js";

describe("resolveAcpAgent", () => {
  it("returns built-in acpx agent as-is (normalized)", () => {
    expect(resolveAcpAgent("codex", undefined, [])).toBe("codex");
  });

  it("resolves fleet agent id by model mapping", () => {
    expect(
      resolveAcpAgent("ibo", undefined, [{ id: "ibo", model: "openai-codex/gpt-5.3-codex" }]),
    ).toBe("codex");
  });

  it("uses default agent when requested id is missing", () => {
    expect(resolveAcpAgent(undefined, "codex", [])).toBe("codex");
  });

  it("throws clear error for unknown agent", () => {
    expect(() => resolveAcpAgent("xyz", undefined, [])).toThrow(
      'ACP agent "xyz" cannot be resolved to an acpx agent.',
    );
  });
});
