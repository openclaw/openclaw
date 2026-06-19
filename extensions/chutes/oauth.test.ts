// Chutes tests cover oauth plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { loginChutes } from "./oauth.js";

function boundedErrorResponse(body: string, status = 500): {
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
});
