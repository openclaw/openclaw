import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixAuthedHttpClient } from "./http-client.js";

const { performMatrixRequestMock } = vi.hoisted(() => ({
  performMatrixRequestMock: vi.fn(),
}));

vi.mock("./transport.js", () => ({
  performMatrixRequest: performMatrixRequestMock,
}));

const auth = { homeserver: "https://matrix.example.org", accessToken: "token" };
const request = {
  method: "GET",
  endpoint: "/_matrix/client/v3/account/whoami",
  timeoutMs: 5000,
} as const;

function mockResponse(
  body: string | Buffer<ArrayBuffer>,
  contentType = "application/json",
  status = 200,
) {
  performMatrixRequestMock.mockResolvedValue({
    response: new Response(body, { status, headers: { "content-type": contentType } }),
    text: body.toString(),
    buffer: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });
}

describe("MatrixAuthedHttpClient", () => {
  let client: MatrixAuthedHttpClient;

  beforeEach(() => {
    performMatrixRequestMock.mockReset();
    client = new MatrixAuthedHttpClient(auth);
  });

  it("parses mixed-case JSON responses and forwards absolute-endpoint opt-in", async () => {
    mockResponse('{"ok":true}', "Application/JSON; charset=utf-8");

    const policies = {
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: "http://proxy.internal:8080",
      },
    };
    const configuredClient = new MatrixAuthedHttpClient({ ...auth, ...policies });
    const absoluteRequest = {
      ...request,
      endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
      allowAbsoluteEndpoint: true,
    };
    const result = await configuredClient.requestJson(absoluteRequest);

    expect(result).toEqual({ ok: true });
    expect(performMatrixRequestMock).toHaveBeenCalledWith({
      ...auth,
      ...policies,
      ...absoluteRequest,
      qs: undefined,
      body: undefined,
    });
  });

  it.each(["application/json-seq", 'text/plain; profile="application/json"'])(
    "does not parse a non-JSON media type containing application/json (%s)",
    async (contentType) => {
      mockResponse('{"ok":true}', contentType);
      const result = await client.requestJson(request);

      expect(result).toBe('{"ok":true}');
    },
  );

  it("returns raw buffers for media requests", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    mockResponse(payload);

    const result = await client.requestRaw({
      ...request,
      endpoint: "/_matrix/media/v3/download/example/id",
    });

    expect(result).toEqual(payload);
  });

  it("raises HTTP errors with status code metadata", async () => {
    mockResponse('{"error":"forbidden"}', "application/json", 403);
    const result = client.requestJson({ ...request, endpoint: "/_matrix/client/v3/rooms" });
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({ message: "forbidden", statusCode: 403 });
  });

  it("throws descriptive error on malformed JSON success response", async () => {
    mockResponse("NOT JSON {{{");
    const result = client.requestJson({ ...request, endpoint: "/_matrix/client/v3/sync" });
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toThrow("malformed JSON");
  });
});
