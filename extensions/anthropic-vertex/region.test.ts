import { afterEach, describe, expect, it, vi } from "vitest";

describe("anthropic-vertex ADC reads", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:fs");
  });

  it("reads explicit ADC credentials without an existsSync preflight", async () => {
    const existsSync = vi.fn(() => false);
    const readFileSync = vi.fn((pathname: string) =>
      pathname.endsWith(".json") ? '{"project_id":"vertex-project"}' : "",
    );
    vi.doMock("node:fs", () => ({
      existsSync,
      readFileSync,
    }));

    const region = await import("./region.js");
    const env = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
    } as NodeJS.ProcessEnv;

    expect(region.resolveAnthropicVertexProjectId(env)).toBe("vertex-project");
    expect(region.hasAnthropicVertexAvailableAuth(env)).toBe(true);
    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });
});
