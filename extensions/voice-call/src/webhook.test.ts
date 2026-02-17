import http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallProvider } from "./providers/base.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "./types.js";
import { VoiceCallConfigSchema } from "./config.js";
import type { CallManager } from "./manager.js";
import { VoiceCallWebhookServer } from "./webhook.js";

function createRequest(body: string): http.IncomingMessage {
  const req = new PassThrough() as PassThrough & {
    headers: http.IncomingHttpHeaders;
    method: string;
    url: string;
    socket: { remoteAddress?: string };
  };
  req.headers = { host: "127.0.0.1" };
  req.method = "POST";
  req.url = "/voice/webhook";
  req.socket = { remoteAddress: "127.0.0.1" };
  req.end(body);
  return req as unknown as http.IncomingMessage;
}

function createResponse(): http.ServerResponse {
  return {
    statusCode: 200,
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as http.ServerResponse;
}

class ThrowingManager {
  readonly processEvent = vi.fn((_event: NormalizedEvent) => {
    throw new Error("persist failed");
  });

  getCallByProviderCallId(): undefined {
    return undefined;
  }

  getCall(): undefined {
    return undefined;
  }

  getActiveCalls(): [] {
    return [];
  }

  async endCall(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async speak(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async speakInitialMessage(): Promise<void> {}
}

class EventProvider implements VoiceCallProvider {
  readonly name = "plivo" as const;

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return {
      events: [
        {
          id: "evt-1",
          type: "call.initiated",
          callId: "call-1",
          providerCallId: "provider-1",
          timestamp: Date.now(),
        },
      ],
      statusCode: 200,
    };
  }

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: "provider-1", status: "initiated" };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {}

  async playTts(_input: PlayTtsInput): Promise<void> {}

  async startListening(_input: StartListeningInput): Promise<void> {}

  async stopListening(_input: StopListeningInput): Promise<void> {}
}

describe("VoiceCallWebhookServer", () => {
  it("does not swallow event-processing failures", async () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new ThrowingManager();
    const server = new VoiceCallWebhookServer(
      config,
      manager as unknown as CallManager,
      new EventProvider(),
    );

    const request = createRequest("{}");
    const response = createResponse();

    await expect(
      (
        server as unknown as {
          handleRequest: (
            req: http.IncomingMessage,
            res: http.ServerResponse,
            webhookPath: string,
          ) => Promise<void>;
        }
      ).handleRequest(request, response, "/voice/webhook"),
    ).rejects.toThrow("persist failed");
    expect(manager.processEvent).toHaveBeenCalledTimes(1);
  });
});
