// Chutes tests cover oauth plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { loginChutes } from "./oauth.js";

const PROVIDER_JSON_MAX_BYTES = 16 * 1024 * 1024;

function boundedErrorResponse(
  body: string,
  status = 500,
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const encoded = new TextEncoder().encode(body);
  let read = false;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("response.text() should not be called");
  });
  const response = {
    ok: false,
    status,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) {
            return { done: true, value: undefined };
          }
          read = true;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
    text,
  } as unknown as Response;

  return { response, cancel, releaseLock, text };
}

/**
 * Builds a streaming Response whose body overflows the shared provider JSON
 * cap (PROVIDER_JSON_MAX_BYTES) so the bounded reader must cancel before the
 * whole body is buffered.
 */
function overflowingSuccessJsonResponse(): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB zero-filled chunk
  let chunkIndex = 0;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: vi.fn(async () => {
      throw new Error("response.json() should not be called on the bounded path");
    }),
    body: {
      getReader: () => ({
        read: async () => {
          // Emit enough chunks to exceed the 16 MiB cap, then close the stream.
          if (chunkIndex > PROVIDER_JSON_MAX_BYTES / chunk.length + 1) {
            return { done: true, value: undefined };
          }
          chunkIndex += 1;
          return { done: false, value: chunk };
        },
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Response;

  return { response, cancel, releaseLock };
}

describe("chutes plugin OAuth", () => {
  it("rejects unsafe token lifetimes before storing credentials", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow("Chutes token exchange returned invalid expires_in");
  });

  it("bounds token exchange error bodies without requiring response.text()", async () => {
    const errorResponse = boundedErrorResponse(
      `${"chutes token unavailable ".repeat(1024)}tail-marker`,
      502,
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return errorResponse.response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Chutes token exchange failed: chutes token unavailable");
    expect(message).not.toContain("tail-marker");
    expect(errorResponse.text).not.toHaveBeenCalled();
    expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
    expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("bounds the active token-exchange success body via readProviderJsonResponse", async () => {
    const overflow = overflowingSuccessJsonResponse();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return overflow.response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Chutes token exchange");
    expect(message.toLowerCase()).toContain("exceeds");
    expect(message).toContain(String(PROVIDER_JSON_MAX_BYTES));
    expect(
      (overflow.response as unknown as { json: ReturnType<typeof vi.fn> }).json,
    ).not.toHaveBeenCalled();
    expect(overflow.cancel).toHaveBeenCalled();
  });

  it("bounds the active userinfo success body via readProviderJsonResponse", async () => {
    const overflow = overflowingSuccessJsonResponse();
    const validToken = new Response(
      '{"access_token":"at_test","refresh_token":"rt_test","expires_in":3600}',
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return validToken;
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return overflow.response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Chutes userinfo");
    expect(message.toLowerCase()).toContain("exceeds");
    expect(message).toContain(String(PROVIDER_JSON_MAX_BYTES));
    expect(
      (overflow.response as unknown as { json: ReturnType<typeof vi.fn> }).json,
    ).not.toHaveBeenCalled();
    expect(overflow.cancel).toHaveBeenCalled();
  });
});
