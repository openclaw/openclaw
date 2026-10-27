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
const policies = {
  ssrfPolicy: { allowPrivateNetwork: true },
  dispatcherPolicy: { mode: "explicit-proxy" as const, proxyUrl: "http://proxy.internal:8080" },
};

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
    client = new MatrixAuthedHttpClient({ ...auth, ...policies });
  });

  it.each([
    ["Application/JSON; charset=utf-8", { ok: true }],
    ["application/json-seq", '{"ok":true}'],
    ['text/plain; profile="application/json"', '{"ok":true}'],
  ] as const)(
    "parses only JSON media types (%s) and forwards request policies",
    async (contentType, expected) => {
      mockResponse('{"ok":true}', contentType);
      const absoluteRequest = {
        ...request,
        endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
        allowAbsoluteEndpoint: true,
      };
      expect(await client.requestJson(absoluteRequest)).toEqual(expected);
      expect(performMatrixRequestMock).toHaveBeenCalledWith({
        ...auth,
        ...policies,
        ...absoluteRequest,
        qs: undefined,
        body: undefined,
      });
    },
  );

  it("returns raw buffers for media requests", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    mockResponse(payload);

    expect(
      await client.requestRaw({ ...request, endpoint: "/_matrix/media/v3/download/example/id" }),
    ).toEqual(payload);
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
