import { describe, expect, it } from "vitest";

import { piSpec } from "./pi.js";

describe("pi agent helpers", () => {
  it("buildArgs injects print/format flags and identity once", () => {
    const argv = ["pi", "hi"];
    const built = piSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: true,
      sessionId: "sess",
      sendSystemOnce: false,
      systemSent: false,
      identityPrefix: "IDENT",
      format: "json",
    });
    expect(built).toContain("-p");
    expect(built).toContain("--mode");
    expect(built).toContain("json");
    expect(built.at(-1)).toContain("IDENT");

    const builtNoIdentity = piSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: false,
      sessionId: "sess",
      sendSystemOnce: true,
      systemSent: true,
      identityPrefix: "IDENT",
      format: "json",
    });
    expect(builtNoIdentity.at(-1)).toBe("hi");
  });

  it("parses final assistant message and preserves usage meta", () => {
    const stdout = [
      '{"type":"message_start","message":{"role":"assistant"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}],"usage":{"input":10,"output":5,"cacheRead":100,"cacheWrite":20,"totalTokens":135},"model":"pi-1","provider":"inflection","stopReason":"end"}}',
    ].join("\n");
    const parsed = piSpec.parseOutput(stdout);
    expect(parsed.texts?.[0]).toBe("hello world");
    expect(parsed.meta?.provider).toBe("inflection");
    expect((parsed.meta?.usage as { output?: number })?.output).toBe(5);
    expect((parsed.meta?.usage as { cacheRead?: number })?.cacheRead).toBe(100);
    expect((parsed.meta?.usage as { cacheWrite?: number })?.cacheWrite).toBe(
      20,
    );
    expect((parsed.meta?.usage as { total?: number })?.total).toBe(135);
  });

  it("piSpec carries tool names when present", () => {
    const stdout =
      '{"type":"message_end","message":{"role":"tool_result","name":"bash","details":{"command":"ls -la"},"content":[{"type":"text","text":"ls output"}]}}';
    const parsed = piSpec.parseOutput(stdout);
    const tool = parsed.toolResults?.[0] as {
      text?: string;
      toolName?: string;
      meta?: string;
    };
    expect(tool?.text).toBe("ls output");
    expect(tool?.toolName).toBe("bash");
    expect(tool?.meta).toBe("ls -la");
  });

  it("keeps usage meta even when assistant message has no text", () => {
    const stdout = [
      '{"type":"message_start","message":{"role":"assistant"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}],"usage":{"input":10,"output":5},"model":"pi-1","provider":"inflection","stopReason":"end"}}',
    ].join("\n");
    const parsed = piSpec.parseOutput(stdout);
    expect(parsed.texts?.length ?? 0).toBe(0);
    expect((parsed.meta?.usage as { input?: number })?.input).toBe(10);
    expect(parsed.meta?.model).toBe("pi-1");
  });
});
