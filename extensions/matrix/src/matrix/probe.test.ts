import { beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({ create: vi.fn(), requestJson: vi.fn() }));

vi.mock("./sdk/http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sdk/http-client.js")>()),
  MatrixAuthedHttpClient: class {
    constructor(params: unknown) {
      httpMocks.create(params);
    }
    requestJson(params: unknown) {
      return httpMocks.requestJson(params);
    }
  },
}));

import { probeMatrix } from "./probe.js";

describe("probeMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    httpMocks.requestJson.mockResolvedValue({ user_id: "@bot:example.org" });
  });

  it("preserves proxy policy and the requested HTTP timeout", async () => {
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://127.0.0.1:7890",
    };
    const result = await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 1234,
      dispatcherPolicy,
    });

    expect(result.ok).toBe(true);
    expect(httpMocks.create).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      ssrfPolicy: undefined,
      dispatcherPolicy,
    });
    expect(httpMocks.requestJson).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/_matrix/client/v3/account/whoami",
      timeoutMs: 1234,
    });
  });

  it("rejects insecure public http homeservers before making a request", async () => {
    const result = await probeMatrix({
      homeserver: "http://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Matrix homeserver must use https://");
    expect(httpMocks.requestJson).not.toHaveBeenCalled();
  });
});
