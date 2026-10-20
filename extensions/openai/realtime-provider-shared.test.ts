import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { createOpenAIRealtimeClientSecret } from "./realtime-provider-shared.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function guardedFetch(response: Response): void {
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn() });
}

function createSecret(
  overrides: Partial<Parameters<typeof createOpenAIRealtimeClientSecret>[0]> = {},
  label?: string,
) {
  return createOpenAIRealtimeClientSecret(
    {
      authToken: "sk-test",
      auditContext: "test",
      session: { model: "gpt-4o-realtime-preview" },
      ...overrides,
    },
    openAIRealtimeHost,
    label,
  );
}

describe("createOpenAIRealtimeClientSecret", () => {
  it("returns client secret from a well-formed response", async () => {
    guardedFetch(
      Response.json({
        client_secret: { value: "eph-secret-abc" },
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
    );

    const result = await createSecret();

    expect(result.value).toBe("eph-secret-abc");
    expect(typeof result.expiresAt).toBe("number");
    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("bounds oversized success response and cancels the stream", async () => {
    // 20 MiB in 1 MiB chunks — well over the 16 MiB cap
    let readCount = 0;
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    guardedFetch(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (readCount >= 20) {
              controller.close();
            } else {
              readCount += 1;
              controller.enqueue(chunk);
            }
          },
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(createSecret()).rejects.toThrow(/openai\.realtime-session/);

    expect(cancel).toHaveBeenCalled();
    expect(readCount).toBeLessThan(20);
  });

  it("replaces rejected transcription API-key details with bounded guidance", async () => {
    guardedFetch(
      Response.json(
        { error: { message: "Incorrect API key provided: secret" } },
        {
          status: 401,
        },
      ),
    );

    await expect(
      createSecret(
        {
          session: { type: "transcription" },
          authRejectedMessage: "Update the transcription API key",
        },
        "OpenAI Realtime transcription",
      ),
    ).rejects.toThrow("Update the transcription API key");
  });
});
