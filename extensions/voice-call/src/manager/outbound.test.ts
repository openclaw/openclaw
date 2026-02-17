import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import { initiateCall } from "./outbound.js";

type InitiateContext = Parameters<typeof initiateCall>[0];

class TestProvider {
  readonly name = "plivo" as const;
  readonly initiateCall = vi.fn(
    async (_input: InitiateCallInput): Promise<InitiateCallResult> => ({
      providerCallId: "provider-1",
      status: "initiated",
    }),
  );

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [] };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {}

  async playTts(_input: PlayTtsInput): Promise<void> {}

  async startListening(_input: StartListeningInput): Promise<void> {}

  async stopListening(_input: StopListeningInput): Promise<void> {}
}

function createContext(overrides: Partial<InitiateContext> = {}): InitiateContext {
  const provider = new TestProvider();
  return {
    activeCalls: new Map(),
    providerCallIdMap: new Map(),
    provider,
    config: VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    }),
    storePath: fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-outbound-test-")),
    webhookUrl: "https://example.com/voice/webhook",
    ...overrides,
  };
}

describe("initiateCall", () => {
  it("returns failure and leaves no active state when initial persist fails", async () => {
    const provider = new TestProvider();
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-voice-call-outbound-missing-${Date.now()}`,
      "missing",
    );
    const ctx = createContext({ provider, storePath });

    const result = await initiateCall(ctx, "+15550000001");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT/i);
    expect(provider.initiateCall).not.toHaveBeenCalled();
    expect(ctx.activeCalls.size).toBe(0);
    expect(ctx.providerCallIdMap.size).toBe(0);
  });

  it("rolls back active state when post-initiation persist fails", async () => {
    const provider = new TestProvider();
    const ctx = createContext({ provider });

    const originalAppendFileSync = fs.appendFileSync;
    let failProviderPersist = true;
    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(
      ((...args: unknown[]) => {
        const data = args[1];
        if (failProviderPersist && typeof data === "string" && data.includes('"providerCallId"')) {
          failProviderPersist = false;
          throw new Error("disk full");
        }
        return Reflect.apply(
          originalAppendFileSync,
          fs,
          args as Parameters<typeof fs.appendFileSync>,
        );
      }) as typeof fs.appendFileSync,
    );

    try {
      const result = await initiateCall(ctx, "+15550000001");

      expect(result.success).toBe(false);
      expect(result.error).toContain("disk full");
      expect(provider.initiateCall).toHaveBeenCalledTimes(1);
      expect(ctx.activeCalls.size).toBe(0);
      expect(ctx.providerCallIdMap.size).toBe(0);
    } finally {
      appendSpy.mockRestore();
    }
  });
});
