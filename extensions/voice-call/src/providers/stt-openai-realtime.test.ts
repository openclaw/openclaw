import { describe, expect, it } from "vitest";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";

describe("OpenAIRealtimeSTTProvider constructor defaults", () => {
  it("uses vadThreshold: 0 when explicitly configured (max sensitivity)", () => {
    const provider = new OpenAIRealtimeSTTProvider({
      apiKey: "sk-test",
      vadThreshold: 0,
    });
    // Access private field via cast for testing
    expect((provider as any).vadThreshold).toBe(0);
  });

  it("uses silenceDurationMs: 0 when explicitly configured", () => {
    const provider = new OpenAIRealtimeSTTProvider({
      apiKey: "sk-test",
      silenceDurationMs: 0,
    });
    expect((provider as any).silenceDurationMs).toBe(0);
  });

  it("falls back to defaults when values are undefined", () => {
    const provider = new OpenAIRealtimeSTTProvider({
      apiKey: "sk-test",
    });
    expect((provider as any).vadThreshold).toBe(0.5);
    expect((provider as any).silenceDurationMs).toBe(800);
  });
});
