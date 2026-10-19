import type { LookupAddress } from "node:dns";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComfyConfig,
  buildLegacyComfyConfig,
  fetchGuardJson,
  mockComfyCloudJobResponses,
  mockComfyProviderApiKey,
  parseComfyJsonBody,
  registerComfyProviders,
} from "./test-helpers.js";

const randomIntMock = vi.hoisted(() => vi.fn<(max: number) => number>());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: randomIntMock.mockImplementation(actual.randomInt) };
});

type FetchWithSsrFGuard = (typeof import("openclaw/plugin-sdk/ssrf-runtime"))["fetchWithSsrFGuard"];

const { fetchWithSsrFGuardMock, ssrfGuardState } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  ssrfGuardState: {} as { actual?: FetchWithSsrFGuard },
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  ssrfGuardState.actual = actual.fetchWithSsrFGuard;
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

const comfyProviders = registerComfyProviders();
const localOrigin = "http://comfyui:8188";
const privateOrigin = "https://private-comfy.example.com";
const localDns = { comfyui: "10.0.0.25" };
const privateDns = { "private-comfy.example.com": "10.0.0.25" };
const privateCloud = {
  baseUrl: privateOrigin,
  mode: "cloud",
  apiKey: "comfy-test-key",
  allowPrivateNetwork: true,
};

type RealGuardParams = Parameters<FetchWithSsrFGuard>[0];
type RealGuardFetchImpl = NonNullable<RealGuardParams["fetchImpl"]>;
type RealGuardLookupFn = NonNullable<RealGuardParams["lookupFn"]>;
type RealComfyFetchOptions = {
  dns: Record<string, string>;
  redirectLocation?: string;
  body?: Buffer;
};

function fetchRequest(call: number): RealGuardParams {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0] as RealGuardParams | undefined;
  if (!request) {
    throw new Error(`expected Comfy fetch call ${call}`);
  }
  return request;
}

function parseJsonBody(call: number): Record<string, unknown> {
  return parseComfyJsonBody(fetchWithSsrFGuardMock, call);
}

function mockLocalImageResponses(
  promptId = "local-prompt-1",
  download: { body: BodyInit; contentType: string } = {
    body: Buffer.from("png-data"),
    contentType: "image/png",
  },
  filename = "generated.png",
) {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(fetchGuardJson({ prompt_id: promptId }))
    .mockResolvedValueOnce(fetchGuardJson(generatedHistory(promptId, filename)))
    .mockResolvedValueOnce({
      response: new Response(download.body, {
        status: 200,
        headers: { "content-type": download.contentType },
      }),
      release: vi.fn(async () => {}),
    });
}

function testWorkflowConfig(config: Record<string, unknown> = {}) {
  return {
    workflow: { "6": { inputs: { text: "" } }, "9": { inputs: {} } },
    promptNodeId: "6",
    outputNodeId: "9",
    ...config,
  };
}

type ImageRequest = Parameters<typeof comfyProviders.image.generateImage>[0];
function generateImage(
  config: Record<string, unknown> = {},
  prompt = "draw a lobster",
  options: Partial<ImageRequest> = {},
) {
  return comfyProviders.image.generateImage({
    provider: "comfy",
    model: "workflow",
    prompt,
    cfg: buildComfyConfig(testWorkflowConfig(config)),
    ...options,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function generatedHistory(promptId: string, filename = "generated.png") {
  return {
    [promptId]: {
      outputs: {
        "9": {
          images: [{ filename, subfolder: "", type: "output" }],
        },
      },
    },
  };
}

function createLookupFn(dns: Record<string, string>): RealGuardLookupFn {
  return (async (hostname: string, options?: unknown) => {
    const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
    const address = dns[normalized] ?? "93.184.216.34";
    const record: LookupAddress = {
      address,
      family: address.includes(":") ? 6 : 4,
    };
    if (
      typeof options === "object" &&
      options !== null &&
      (options as { all?: unknown }).all === true
    ) {
      return [record];
    }
    return record;
  }) as RealGuardLookupFn;
}

function installRealComfyFetchGuard(options: RealComfyFetchOptions) {
  // Keep injected DNS authoritative and avoid ambient proxy capture.
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);

  const promptId = "real-guard-prompt-1";
  const body = options.body ?? Buffer.from("png-data");
  const fetchUrls: string[] = [];
  const guardCalls: RealGuardParams[] = [];
  const lookupFn = createLookupFn(options.dns);
  const fetchImpl: RealGuardFetchImpl = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchUrls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/prompt")) {
      return jsonResponse({ prompt_id: promptId });
    }
    if (parsed.pathname === `/api/job/${promptId}/status`) {
      return jsonResponse({ status: "completed" });
    }
    if (
      parsed.pathname === `/history/${promptId}` ||
      parsed.pathname === `/api/history_v2/${promptId}`
    ) {
      return jsonResponse(generatedHistory(promptId));
    }
    if (["/view", "/api/view"].includes(parsed.pathname) && options.redirectLocation) {
      return new Response(null, {
        status: 302,
        headers: { location: options.redirectLocation },
      });
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };

  const actualFetchWithSsrFGuard = ssrfGuardState.actual;
  if (!actualFetchWithSsrFGuard) {
    throw new Error("expected actual SSRF guard");
  }
  fetchWithSsrFGuardMock.mockImplementation(async (params) => {
    guardCalls.push(params);
    return await actualFetchWithSsrFGuard({
      ...params,
      fetchImpl,
      lookupFn,
    });
  });
  return { fetchUrls, guardCalls };
}

describe("comfy image-generation provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("falls back to legacy models.providers comfy config when plugin config is absent", async () => {
    expect(
      await comfyProviders.image.isConfiguredAsync?.({
        cfg: buildLegacyComfyConfig({
          workflow: { "6": { inputs: { text: "" } } },
          promptNodeId: "6",
        }),
      }),
    ).toBe(true);
  });

  it("treats cloud comfy workflows as configured with a plugin config env SecretRef", async () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    expect(
      await comfyProviders.image.isConfiguredAsync?.({
        cfg: buildComfyConfig({
          mode: "cloud",
          apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
          image: { workflow: { "6": { inputs: { text: "" } } }, promptNodeId: "6" },
        }),
      }),
    ).toBe(true);
  });

  it.each([
    [
      { completed: true, status_str: "success" },
      "Comfy workflow local-prompt-1 completed without image outputs",
    ],
    [
      {
        completed: false,
        status_str: "error",
        messages: [["execution_error", { exception_message: "Missing checkpoint" }]],
      },
      "Comfy workflow failed: Missing checkpoint",
    ],
  ] as const)("reports terminal local history %j after one lookup", async (status, error) => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "local-prompt-1" }))
      .mockResolvedValueOnce(
        fetchGuardJson({
          "local-prompt-1": { status, outputs: {} },
        }),
      );

    await expect(generateImage({ timeoutMs: 1_000 })).rejects.toThrow(error);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing env", { source: "env", provider: "default", id: "COMFY_HEADER_MISSING" }, false],
    ["file ref", { source: "file", provider: "comfyfile", id: "value" }, true],
  ])("checks %s header availability for every capability", async (_label, header, configured) => {
    vi.stubEnv("COMFY_HEADER_AVAILABLE", "Basic fixture");
    vi.stubEnv("COMFY_HEADER_MISSING", undefined);
    for (const [capability, provider] of [
      ["image", comfyProviders.image],
      ["video", comfyProviders.video],
      ["music", comfyProviders.music],
    ] as const) {
      const cfg = buildComfyConfig({
        [capability]: testWorkflowConfig(),
        headers: { Authorization: header },
      });
      expect(await provider.isConfiguredAsync?.({ cfg })).toBe(configured);
    }
  });

  it("injects a fresh custom seed without mutating the workflow", async () => {
    const seedInputName = "noise_seed";
    randomIntMock.mockReturnValueOnce(0).mockReturnValueOnce(2 ** 48 - 2);
    mockLocalImageResponses("seed-prompt-1");
    mockLocalImageResponses("seed-prompt-2");

    const workflow = {
      "4": { inputs: { seed: 0 } },
      "6": { inputs: { text: "" } },
      "9": { inputs: {} },
    };
    const cfg = buildComfyConfig(
      testWorkflowConfig({
        workflow: structuredClone(workflow),
        seedNodeId: "4",
        seedInputName,
      }),
    );

    await generateImage({}, "first", { cfg });
    await generateImage({}, "second", { cfg });

    expect(parseJsonBody(1)).toMatchObject({ prompt: { "4": { inputs: { noise_seed: 0 } } } });
    expect(parseJsonBody(4)).toMatchObject({
      prompt: { "4": { inputs: { noise_seed: 2 ** 48 - 2 } } },
    });
    expect(cfg.plugins?.entries?.comfy?.config?.workflow).toEqual(workflow);
  });

  it.each([
    { host: "comfyui", mode: "cloud", allowed: false, privateNetwork: false },
    { host: "images.example.com", mode: "local", allowed: false, privateNetwork: false },
    {
      host: "comfy.private.example.com",
      mode: "local",
      allowed: false,
      privateNetwork: true,
      address: "169.254.169.254",
    },
    { host: "comfyui", mode: "local", allowed: true, privateNetwork: false },
    { host: "comfy.private.example.com", mode: "local", allowed: true, privateNetwork: true },
  ])(
    "$mode $host private=$privateNetwork allowed=$allowed",
    async ({ host, mode, allowed, privateNetwork, address }) => {
      const baseUrl = `http://${host}:8188`;
      const harness = installRealComfyFetchGuard({ dns: { [host]: address ?? "10.0.0.25" } });
      const result = generateImage({
        baseUrl,
        mode,
        ...(privateNetwork ? { allowPrivateNetwork: true } : {}),
        ...(mode === "cloud" ? { apiKey: "comfy-test-key" } : {}),
      });
      const submitUrl = `${baseUrl}${mode === "cloud" ? "/api" : ""}/prompt`;
      if (allowed) {
        expect((await result).images[0]?.buffer).toEqual(Buffer.from("png-data"));
        expect(harness.fetchUrls).toContain(submitUrl);
        expect(harness.guardCalls).toHaveLength(3);
      } else {
        await expect(result).rejects.toThrow(
          "Blocked: resolves to private/internal/special-use IP address",
        );
        expect(harness.fetchUrls).toEqual([]);
        expect(harness.guardCalls).toHaveLength(1);
      }
      expect(harness.guardCalls[0]?.url).toBe(submitUrl);
    },
  );

  it.each([
    [
      localOrigin,
      "http://assets.comfyui:8188/generated.png",
      { comfyui: "10.0.0.25", "assets.comfyui": "10.0.0.26" },
      "Blocked",
      false,
    ],
    [localOrigin, "http://comfyui:8288/generated.png", localDns, "Blocked", false],
    [
      "https://comfy.example.com",
      "https://cdn.example.com/generated.png",
      { "comfy.example.com": "93.184.216.34", "cdn.example.com": "93.184.216.35" },
      "Blocked hostname (not in allowlist)",
      false,
    ],
    [
      privateOrigin,
      "http://other-private.example.com/generated.png",
      { "private-comfy.example.com": "10.0.0.25", "other-private.example.com": "10.0.0.26" },
      "Blocked",
      true,
    ],
    [privateOrigin, "http://169.254.169.254/latest/meta-data", privateDns, "Blocked", true],
  ] as const)(
    "blocks redirect from %s to %s",
    async (baseUrl, redirectLocation, dns, error, cloud) => {
      const harness = installRealComfyFetchGuard({ dns, redirectLocation });
      await expect(generateImage(cloud ? privateCloud : { baseUrl })).rejects.toThrow(error);
      expect(harness.fetchUrls).not.toContain(redirectLocation);
    },
  );

  it("allows explicit private cloud origin redirecting to public CDNs", async () => {
    const harness = installRealComfyFetchGuard({
      dns: {
        ...privateDns,
        "cdn.example.com": "93.184.216.34",
      },
      redirectLocation: "https://cdn.example.com/generated.png",
      body: Buffer.from("cdn-data"),
    });

    const result = await generateImage(privateCloud, "cloud workflow prompt");

    expect(harness.fetchUrls).toContain(`${privateOrigin}/api/prompt`);
    expect(harness.fetchUrls).toContain("https://cdn.example.com/generated.png");
    expect(harness.guardCalls).toHaveLength(4);
    expect(result.images[0]?.buffer).toEqual(Buffer.from("cdn-data"));
  });

  it("caps oversized local workflow timeouts", async () => {
    // Advance from fetch, not clock-call counts: provider init also reads this clock.
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    fetchWithSsrFGuardMock.mockImplementation(async () => {
      const call = fetchWithSsrFGuardMock.mock.calls.length;
      if (call >= 2) {
        monotonicNow = MAX_TIMER_TIMEOUT_MS + 1;
      }
      return call === 1
        ? fetchGuardJson({ prompt_id: "local-prompt-1" })
        : fetchGuardJson({ "local-prompt-1": { outputs: {} } });
    });

    await expect(generateImage({ timeoutMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
      "Comfy workflow did not finish within 2147000s",
    );
    expect(fetchRequest(1).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(fetchRequest(2).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps generated image downloads above the configured media cap", async () => {
    mockLocalImageResponses("local-prompt-1", {
      body: Buffer.from("over-cap"),
      contentType: "image/png",
    });

    const result = await generateImage({}, "draw a lobster", {
      cfg: {
        ...buildComfyConfig(testWorkflowConfig()),
        agents: { defaults: { mediaMaxMb: 0.000001 } },
      } as never,
    });
    expect(result.images[0]?.buffer.toString()).toBe("over-cap");
  });

  it("reports malformed local workflow submit JSON as a provider error", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    await expect(generateImage()).rejects.toThrow(
      "Comfy workflow submit failed: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized local workflow submit responses and releases the request", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const totalBytes = 32 * chunk.length;
    let bytesPulled = 0;
    let canceled = false;
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bytesPulled >= totalBytes) {
              controller.close();
              return;
            }
            bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release,
    });

    await expect(generateImage()).rejects.toThrow(
      "Comfy workflow submit failed: JSON response exceeds 16777216 bytes",
    );
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(totalBytes);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uploads reference images for local edit workflows", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(fetchGuardJson({ name: "upload.png" }));
    mockLocalImageResponses(
      "local-edit-1",
      { body: Buffer.from("edited-data"), contentType: "image/png" },
      "edited.png",
    );

    await generateImage(
      {
        workflow: {
          "6": { inputs: { text: "" } },
          "7": { inputs: { image: "" } },
          "9": { inputs: {} },
        },
        inputImageNodeId: "7",
      },
      "turn this into a poster",
      {
        inputImages: [
          { buffer: Buffer.from("source"), mimeType: "image/png", fileName: "source.png" },
        ],
      },
    );

    const uploadRequest = fetchRequest(1);
    expect(uploadRequest).toMatchObject({
      url: "http://127.0.0.1:8188/upload/image",
      auditContext: "comfy-image-upload",
      init: { method: "POST" },
    });
    const uploadForm = uploadRequest?.init?.body;
    if (!(uploadForm instanceof FormData)) {
      throw new Error("expected Comfy upload request body to be FormData");
    }
    expect(uploadForm.get("type")).toBe("input");
    expect(uploadForm.get("overwrite")).toBe("true");

    expect(parseJsonBody(2)).toEqual({
      prompt: {
        "6": { inputs: { text: "turn this into a poster" } },
        "7": { inputs: { image: "upload.png" } },
        "9": { inputs: {} },
      },
    });
  });

  it("uses cloud endpoints, auth headers, and partner-node extra_data", async () => {
    vi.stubEnv("COMFY_API_KEY", "stale-env-key");
    mockComfyProviderApiKey("profile-key");
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "cloud-job-1",
    });

    const result = await generateImage({ mode: "cloud" }, "cloud workflow prompt");

    const submitRequest = fetchRequest(1);
    expect(submitRequest).toMatchObject({
      url: "https://cloud.comfy.org/api/prompt",
      auditContext: "comfy-image-generate",
    });
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("profile-key");
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "cloud workflow prompt" } },
        "9": { inputs: {} },
      },
      extra_data: {
        api_key_comfy_org: "profile-key",
      },
    });

    expect([2, 3, 4].map(fetchRequest)).toMatchObject([
      { url: "https://cloud.comfy.org/api/job/cloud-job-1/status", auditContext: "comfy-status" },
      { url: "https://cloud.comfy.org/api/history_v2/cloud-job-1", auditContext: "comfy-history" },
      {
        url: "https://cloud.comfy.org/api/view?filename=cloud.png&subfolder=&type=output",
        auditContext: "comfy-image-download",
      },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
    expect(result.metadata).toEqual({
      promptId: "cloud-job-1",
      outputNodeIds: ["9"],
    });
  });
});
