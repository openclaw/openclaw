import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComfyConfig, registerComfyProviders } from "./test-helpers.js";

const comfyProviders = registerComfyProviders();

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type ImageRequest = Parameters<typeof comfyProviders.image.generateImage>[0];
function generate(
  headers: Record<string, unknown>,
  config: Record<string, unknown> = {},
  options: {
    inputImages?: ImageRequest["inputImages"];
    secrets?: NonNullable<ImageRequest["cfg"]>["secrets"];
  } = {},
) {
  const cfg = buildComfyConfig({
    workflow: { "6": { inputs: { text: "" } }, "9": { inputs: {} } },
    promptNodeId: "6",
    outputNodeId: "9",
    mode: "local",
    baseUrl,
    headers,
    ...config,
  });
  return comfyProviders.image.generateImage({
    provider: "comfy",
    model: "workflow",
    prompt: "draw a lobster",
    cfg: { ...cfg, secrets: options.secrets },
    inputImages: options.inputImages,
  });
}

function expectAuthorizedImage(result: Awaited<ReturnType<typeof generate>>, auth: string) {
  expect(receivedAuthHeaders).toHaveLength(3);
  expect(receivedAuthHeaders.every((header) => header === auth)).toBe(true);
  expect(result.images[0]?.buffer).toEqual(TINY_PNG);
}

let server: http.Server;
let baseUrl: string;
const receivedAuthHeaders: (string | undefined)[] = [];
let failurePath: string | undefined;
let terminalFailure = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    receivedAuthHeaders.push(req.headers.authorization);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.resume();
    if (url.pathname === failurePath) {
      const credential = req.headers.authorization?.split(" ")[1];
      const detail = `proxy rejected ${credential} ${String(req.headers["x-proxy-auth"])}`;
      json(
        terminalFailure ? { status: "failed", error: detail } : { error: detail },
        terminalFailure ? 200 : 403,
      );
      return;
    }
    if (url.pathname === "/upload/image") {
      return json({ name: "input.png" });
    }
    if (req.method === "POST" && url.pathname.endsWith("/prompt")) {
      return json({ prompt_id: "proof-1" });
    }
    if (req.method === "GET" && url.pathname === "/history/proof-1") {
      return json({
        "proof-1": {
          outputs: {
            "9": { images: [{ filename: "proof.png", subfolder: "", type: "output" }] },
          },
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  receivedAuthHeaders.length = 0;
  failurePath = undefined;
  terminalFailure = false;
});

afterEach(() => vi.unstubAllEnvs());

describe("comfy headers: real sockets, real SecretRef resolution (no mocks)", () => {
  it.each([
    ["upload", "/upload/image", false],
    ["submit", "/prompt", false],
    ["history", "/history/proof-1", false],
    ["download", "/view", false],
    ["cloud status", "/api/job/proof-1/status", true],
  ])("redacts reflected headers from %s errors", async (_label, endpoint, cloud) => {
    failurePath = endpoint;
    terminalFailure = cloud;
    const credential = "comfy-fixture-credential";
    const customHeader = "comfy-fixture-proxy-value";
    const result = await generate(
      { Authorization: `Basic ${credential}`, "X-Proxy-Auth": customHeader },
      {
        mode: cloud ? "cloud" : "local",
        apiKey: cloud ? "comfy-fixture-cloud-key" : undefined,
        allowPrivateNetwork: cloud,
        inputImageNodeId: "6",
      },
      endpoint === "/upload/image"
        ? { inputImages: [{ buffer: TINY_PNG, mimeType: "image/png" }] }
        : {},
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(inspect(result)).toContain("proxy rejected");
    expect(inspect(result)).not.toContain(credential);
    expect(inspect(result)).not.toContain(customHeader);
    expect(receivedAuthHeaders.length).toBeGreaterThan(0);
  });

  it("resolves an env-backed SecretRef Authorization header across all three real requests and completes generation", async () => {
    const expectedAuth = `Basic ${Buffer.from(`env:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
    vi.stubEnv("COMFY_HEADER_PROOF_ENV", expectedAuth);
    const result = await generate({
      Authorization: { source: "env", provider: "default", id: "COMFY_HEADER_PROOF_ENV" },
    });
    expectAuthorizedImage(result, expectedAuth);
  });

  it("resolves a non-env (file-backed) SecretRef Authorization header across all three real requests", async () => {
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "comfy-header-secret-"));
    const tmpFile = join(tmpDir, "token.txt");
    const expectedAuth = `Basic ${Buffer.from(`file:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
    await fs.writeFile(tmpFile, expectedAuth);
    await fs.chmod(tmpFile, 0o600);
    try {
      const result = await generate(
        { Authorization: { source: "file", provider: "comfyheaderfile", id: "value" } },
        {},
        {
          secrets: {
            providers: { comfyheaderfile: { source: "file", path: tmpFile, mode: "singleValue" } },
          },
        },
      );
      expectAuthorizedImage(result, expectedAuth);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stops before any real request when the SecretRef is unresolvable (fail-closed)", async () => {
    vi.stubEnv("COMFY_HEADER_PROOF_MISSING", undefined);
    await expect(
      generate({
        Authorization: { source: "env", provider: "default", id: "COMFY_HEADER_PROOF_MISSING" },
      }),
    ).rejects.toThrow(/unavailable secret/);
    expect(receivedAuthHeaders).toHaveLength(0);
  });
});
