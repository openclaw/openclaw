import fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { buildComfyConfig, registerComfyProviders } from "./test-helpers.js";

const comfyProviders = registerComfyProviders();

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const imageOutput = { images: [{ filename: "proof.png", subfolder: "", type: "output" }] };

type ImageRequest = Parameters<typeof comfyProviders.image.generateImage>[0];
function generate(
  headers: Record<string, unknown>,
  config: Record<string, unknown> = {},
  options: Pick<ImageRequest, "inputImages"> &
    Pick<NonNullable<ImageRequest["cfg"]>, "secrets"> = {},
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

let server: http.Server;
let baseUrl: string;
const receivedAuthHeaders: (string | undefined)[] = [];
let failurePath: string | undefined;

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
      const terminalFailure = failurePath.startsWith("/api/");
      const detail = `proxy rejected ${req.headers.authorization?.split(" ")[1]} ${String(req.headers["x-proxy-auth"])}`;
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
      return json({ "proof-1": { outputs: { "9": imageOutput } } });
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "content-type": "image/png" }).end(TINY_PNG);
      return;
    }
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
});

afterAll(() => server[Symbol.asyncDispose]());

beforeEach(() => {
  receivedAuthHeaders.length = 0;
  failurePath = undefined;
});

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["upload", "/upload/image", false],
  ["submit", "/prompt", false],
  ["history", "/history/proof-1", false],
  ["download", "/view", false],
  ["cloud status", "/api/job/proof-1/status", true],
])("redacts reflected headers from %s errors", async (_label, endpoint, cloud) => {
  failurePath = endpoint;
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

it.each(["env", "file"] as const)("resolves %s headers over real sockets", async (source) => {
  const expectedAuth = `Basic ${Buffer.from(`${source}:${Math.random().toString(36).slice(2)}`).toString("base64")}`;
  const tmpDir =
    source === "file" ? await fs.mkdtemp(join(tmpdir(), "comfy-header-secret-")) : undefined;
  try {
    const options: Parameters<typeof generate>[2] = {};
    const ref = { source, provider: "default", id: "COMFY_HEADER_PROOF_ENV" };
    if (tmpDir) {
      const path = join(tmpDir, "token.txt");
      await fs.writeFile(path, expectedAuth, { mode: 0o600 });
      ref.provider = "comfyheaderfile";
      ref.id = "value";
      options.secrets = {
        providers: { comfyheaderfile: { source: "file", path, mode: "singleValue" } },
      };
    } else {
      vi.stubEnv(ref.id, expectedAuth);
    }
    const result = await generate({ Authorization: ref }, {}, options);
    expect(receivedAuthHeaders).toEqual([expectedAuth, expectedAuth, expectedAuth]);
    expect(result.images[0]?.buffer).toEqual(TINY_PNG);
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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
