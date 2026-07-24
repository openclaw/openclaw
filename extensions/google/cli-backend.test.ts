// Google CLI backend tests cover bundled CLI runtime descriptors.
import { describe, expect, it } from "vitest";
import { buildGoogleAntigravityCliBackend, buildGoogleGeminiCliBackend } from "./cli-backend.js";

describe("google cli backends", () => {
  it("keeps the Gemini CLI backend configured for JSON sessions", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.id).toBe("google-gemini-cli");
    expect(backend.modelProvider).toBe("google");
    expect(backend.config.command).toBe("gemini");
    expect(backend.config.output).toBe("json");
    expect(backend.config.sessionMode).toBe("existing");
  });

  it("builds the Antigravity CLI backend around agy text output", () => {
    const backend = buildGoogleAntigravityCliBackend();

    expect(backend.id).toBe("google-antigravity-cli");
    expect(backend.modelProvider).toBe("google");
    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.liveTest).toMatchObject({
      defaultModelRef: "google-antigravity-cli/gemini-3.5-flash",
      defaultImageProbe: false,
      defaultMcpProbe: false,
      docker: { binaryName: "agy" },
    });
    expect(backend.config).toMatchObject({
      command: "agy",
      args: ["--print", "{prompt}"],
      output: "text",
      input: "arg",
      modelArg: "--model",
      modelAliases: {
        flash: "gemini-3.5-flash",
        pro: "gemini-3.1-pro-preview",
      },
      sessionMode: "none",
      serialize: true,
    });
    expect(backend.config).not.toHaveProperty("parseToolCalls");
    expect(backend.config).not.toHaveProperty("imageArg");
    expect(backend.config).not.toHaveProperty("imagePathScope");
  });
});
