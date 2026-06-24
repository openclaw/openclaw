// Googlechat tests cover api module behavior, including the bounded JSON
// reader swap that prevents an oversized Google Chat response from buffering
// the full payload before parsing.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  getGoogleChatAccessToken: vi.fn(async () => "test-token"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
}));

let sendGoogleChatMessage: typeof import("./api.js").sendGoogleChatMessage;

beforeAll(async () => {
  ({ sendGoogleChatMessage } = await import("./api.js"));
});

function overflowingSuccessJsonResponse(): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(async () => undefined);
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB zero-filled chunk
  let chunkIndex = 0;
  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: vi.fn(async () => {
        throw new Error("response.json() must not be called on the bounded path");
      }),
      body: {
        getReader: () => ({
          read: async () => {
            // Emit enough chunks to exceed the 16 MiB cap, then close the stream.
            if (chunkIndex > 18) {
              return { done: true, value: undefined };
            }
            chunkIndex += 1;
            return { done: false, value: chunk };
          },
          cancel,
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response,
    cancel,
  };
}

function smallValidJsonResponse(): Response {
  return new Response(
    JSON.stringify({ name: "spaces/AAA/messages/BBB", thread: { name: "spaces/AAA/threads/1" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "test-account",
    enabled: true,
    config: {} as ResolvedGoogleChatAccount["config"],
    credentialSource: "inline",
    credentials: {},
  };
}

describe("googlechat api bounded reader (sendGoogleChatMessage path)", () => {
  it("rejects oversized Google Chat API success bodies via the bounded reader", async () => {
    const overflow = overflowingSuccessJsonResponse();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: overflow.response,
      release: async () => undefined,
    });

    let error: Error | null = null;
    try {
      await sendGoogleChatMessage({
        account: buildAccount(),
        space: "spaces/AAA",
        text: "hello world",
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    // The bounded reader's canonical overflow message must surface verbatim —
    // not get rewrapped as "Google Chat API request failed: malformed JSON response".
    expect(error?.message).toMatch(/Google Chat API request failed/);
    expect(error?.message).toMatch(/exceeds 16777216 bytes/);
    // The bounded reader cancelled the underlying stream before draining the body.
    expect(overflow.cancel).toHaveBeenCalled();
  });

  it("parses small valid Google Chat API success bodies end-to-end", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: smallValidJsonResponse(),
      release: async () => undefined,
    });

    const result = await sendGoogleChatMessage({
      account: buildAccount(),
      space: "spaces/AAA",
      text: "hello world",
    });
    expect(result?.messageName).toBe("spaces/AAA/messages/BBB");
    expect(result?.threadName).toBe("spaces/AAA/threads/1");
  });
});
