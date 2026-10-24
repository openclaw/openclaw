import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import { postJson } from "./post-json.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

const API_KEY = "memory/Start~OC_T24_13_UNIQUE_NEEDLE-memoryEnd";
const SHORT_API_KEY = "t7K4_x";
const UNIQUE_NEEDLE = "OC_T24_13_UNIQUE_NEEDLE";

type RequestRecord = {
  authorization: string | undefined;
  body: string;
  contentType: string | undefined;
  path: string;
};

async function fixture() {
  const records: RequestRecord[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const path = request.url ?? "/";
      const authorization = request.headers.authorization;
      records.push({
        authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"],
        path,
      });

      let status = 200;
      let body: string;
      if (path.includes("/quoted-error/") || path.endsWith("/quoted-error")) {
        status = 401;
        body = JSON.stringify({ Authorization: authorization });
      } else if (path.includes("/error/") || path.endsWith("/error")) {
        status = 401;
        body = `upstream echoed Authorization: ${authorization}`;
      } else if (path.endsWith("/benign")) {
        status = 400;
        body = "harmless diagnostic";
      } else if (path.endsWith("/embeddings/ok")) {
        body = '{"data":[{"embedding":[0.25,0.5]}]}';
      } else if (path.endsWith("/files")) {
        body = '{"id":"file_control"}';
      } else {
        status = 404;
        body = "not found";
      }
      response.writeHead(status, {
        connection: "close",
        "content-length": String(Buffer.byteLength(body)),
        "content-type": status === 200 ? "application/json" : "text/plain",
      });
      response.end(body);
    });
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { records, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function expectRedacted(error: unknown, message: string, secrets = [API_KEY, UNIQUE_NEEDLE]) {
  expect(error).toMatchObject({ message: expect.stringContaining(message) });
  expect(error).toBeInstanceOf(Error);
  for (const secret of secrets) {
    expect((error as Error).message).not.toContain(secret);
  }
}

function fetchVectors(baseUrl: string, path: string, key = API_KEY) {
  return fetchRemoteEmbeddingVectors({
    url: `${baseUrl}${path}`,
    headers: { Authorization: `bearer ${key}`, "Content-Type": "application/json" },
    ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    body: { model: "proof", input: ["one"] },
    errorPrefix: "embedding fetch failed",
  });
}

describe("memory remote error redaction", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [API_KEY, "error", "Authorization: ***"],
    [SHORT_API_KEY, "quoted-error", '{"Authorization":"***"}'],
  ])("redacts bearer credentials from %s embedding errors", async (key, route, redacted) => {
    const { records, baseUrl } = await fixture();
    const error = await fetchVectors(baseUrl, `/v1/embeddings/${route}`, key).catch(
      (cause: unknown) => cause,
    );
    expectRedacted(error, redacted, key === API_KEY ? [API_KEY, UNIQUE_NEEDLE] : [SHORT_API_KEY]);
    if (key === API_KEY) {
      expect(error).toMatchObject({
        message: expect.stringContaining(
          "embedding fetch failed (model: proof, batch size: 1) (401)",
        ),
      });
      await expect(fetchVectors(baseUrl, "/v1/embeddings/ok")).resolves.toEqual([[0.25, 0.5]]);
    }
    expect(records.map((record) => record.authorization)).toEqual(
      Array.from({ length: key === API_KEY ? 2 : 1 }, () => `bearer ${key}`),
    );
  });

  it("preserves status metadata and harmless provider diagnostics", async () => {
    const { baseUrl } = await fixture();
    const request = (path: string) =>
      postJson({
        url: `${baseUrl}${path}`,
        headers: { Authorization: `Bearer ${API_KEY}` },
        ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        body: {},
        errorPrefix: "post failed",
        parse: (payload) => payload,
      });

    const secretError = await request("/v1/post/error").catch((cause: unknown) => cause);
    expect((secretError as { status?: unknown }).status).toBe(401);
    expectRedacted(secretError, "post failed (401)");

    const benignError = await request("/v1/post/benign").catch((cause: unknown) => cause);
    expect(benignError).toBeInstanceOf(Error);
    expect(benignError).toMatchObject({
      status: 400,
      message: "post failed (400): harmless diagnostic",
    });
  });

  it("redacts lower-case bearer credentials from batch errors without changing success", async () => {
    const { records, baseUrl } = await fixture();
    const upload = (path: string, key = API_KEY) =>
      uploadBatchJsonlFile({
        client: {
          baseUrl: `${baseUrl}${path}`,
          headers: { Authorization: `bearer ${key}` },
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      });

    const error = await upload("/error").catch((cause: unknown) => cause);
    expectRedacted(error, "file upload failed: 401");

    const shortError = await upload("/quoted-error", SHORT_API_KEY).catch(
      (cause: unknown) => cause,
    );
    expectRedacted(shortError, '{"Authorization":"***"}', [SHORT_API_KEY]);

    await expect(upload("/ok")).resolves.toBe("file_control");
    const batchRecords = records.filter((record) => record.path.endsWith("/files"));
    expect(batchRecords[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    expect(batchRecords[0]?.body).toContain('name="purpose"');
    expect(batchRecords[0]?.body).toContain("batch");
    expect(batchRecords.map((record) => record.authorization)).toEqual([
      `bearer ${API_KEY}`,
      `bearer ${SHORT_API_KEY}`,
      `bearer ${API_KEY}`,
    ]);
  });
});
