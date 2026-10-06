import type { LookupAddress } from "node:dns";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import {
  buildComfyConfig,
  buildLegacyComfyConfig,
  fetchGuardJson,
  mockComfyCloudJobResponses,
  mockComfyProviderApiKey,
  parseComfyJsonBody,
} from "./test-helpers.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

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

type FetchGuardRequest = {
  url?: unknown;
  auditContext?: unknown;
  timeoutMs?: unknown;
  init?: {
    method?: unknown;
    headers?: HeadersInit;
    body?: BodyInit | null;
  };
};
type RealGuardParams = Parameters<FetchWithSsrFGuard>[0];
type RealGuardFetchImpl = NonNullable<RealGuardParams["fetchImpl"]>;
type RealGuardLookupFn = NonNullable<RealGuardParams["lookupFn"]>;
type RealGuardHarness = {
  fetchUrls: string[];
  guardCalls: RealGuardParams[];
};

type RealComfyFetchOptions = {
  dns: Record<string, string>;
  promptId?: string;
  redirectLocation?: string;
  body?: Buffer;
  contentType?: string;
};

function fetchRequest(call: number): FetchGuardRequest {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0] as FetchGuardRequest | undefined;
  if (!request) {
    throw new Error(`expected Comfy fetch call ${call}`);
  }
  return request;
}

function parseJsonBody(call: number): Record<string, unknown> {
  return parseComfyJsonBody(fetchWithSsrFGuardMock, call);
}

function seedFromBody(body: Record<string, unknown>, nodeId: string, inputName = "seed") {
  const prompt = body.prompt as Record<string, { inputs: Record<string, number> }>;
  const node = prompt[nodeId];
  if (!node) {
    throw new Error(`expected seed node "${nodeId}" in submitted workflow`);
  }
  return node.inputs[inputName];
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
    workflow: {
      "6": { inputs: { text: "" } },
      "9": { inputs: {} },
    },
    promptNodeId: "6",
    outputNodeId: "9",
    ...config,
  };
}

function generateImage(config: Record<string, unknown> = {}, prompt = "draw a lobster") {
  return buildComfyImageGenerationProvider().generateImage({
    provider: "comfy",
    model: "workflow",
    prompt,
    cfg: buildComfyConfig(testWorkflowConfig(config)),
  });
}

function toFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
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

function installRealComfyFetchGuard(options: RealComfyFetchOptions): RealGuardHarness {
  // Keep injected DNS authoritative and avoid ambient proxy capture.
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);

  const promptId = options.promptId ?? "real-guard-prompt-1";
  const body = options.body ?? Buffer.from("png-data");
  const contentType = options.contentType ?? "image/png";
  const fetchUrls: string[] = [];
  const guardCalls: RealGuardParams[] = [];
  const lookupFn = createLookupFn(options.dns);
  const fetchImpl: RealGuardFetchImpl = async (input) => {
    const url = toFetchUrl(input);
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
    if (parsed.pathname === "/view" || parsed.pathname === "/api/view") {
      if (options.redirectLocation) {
        return new Response(null, {
          status: 302,
          headers: { location: options.redirectLocation },
        });
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-type": contentType },
      });
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": contentType },
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

  it("falls back to legacy models.providers comfy config when plugin config is absent", () => {
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildLegacyComfyConfig({
          workflow: {
            "6": { inputs: { text: "" } },
          },
          promptNodeId: "6",
        }),
      }),
    ).toBe(true);
  });

  it("treats cloud comfy workflows as configured with a plugin config env SecretRef", () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          mode: "cloud",
          apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
          image: {
            workflow: {
              "6": { inputs: { text: "" } },
            },
            promptNodeId: "6",
          },
        }),
      }),
    ).toBe(true);
  });

  it("uses provider-owned config auth for a complete Comfy Cloud workflow", () => {
    const cfg = buildComfyConfig({
      mode: "cloud",
      image: {
        workflow: { "6": { inputs: { text: "" } } },
        promptNodeId: "6",
      },
    });
    cfg.models = {
      providers: {
        comfy: {
          apiKey: "comfy-provider-config-key",
          baseUrl: "https://cloud.comfy.org",
          models: [],
        },
      },
    };

    expect(buildComfyImageGenerationProvider().isConfigured?.({ cfg })).toBe(true);
  });

  it("does not let provider config auth bypass incomplete Comfy Cloud workflows", () => {
    const cfg = buildComfyConfig({ mode: "cloud" });
    cfg.models = {
      providers: {
        comfy: {
          apiKey: "comfy-provider-config-key",
          baseUrl: "https://cloud.comfy.org",
          models: [],
        },
      },
    };

    expect(buildComfyImageGenerationProvider().isConfigured?.({ cfg })).toBe(false);
  });

  it("preserves an unavailable plugin-secret veto even with provider config auth", () => {
    vi.stubEnv("COMFY_MISSING_PLUGIN_SECRET", "");
    const cfg = buildComfyConfig({
      mode: "cloud",
      apiKey: { source: "env", provider: "default", id: "COMFY_MISSING_PLUGIN_SECRET" },
      image: {
        workflow: { "6": { inputs: { text: "" } } },
        promptNodeId: "6",
      },
    });
    cfg.models = {
      providers: {
        comfy: {
          apiKey: "comfy-provider-config-key",
          baseUrl: "https://cloud.comfy.org",
          models: [],
        },
      },
    };

    expect(buildComfyImageGenerationProvider().isConfigured?.({ cfg })).toBe(false);
  });

  it("submits a local workflow, waits for history, and downloads images", async () => {
    mockLocalImageResponses();

    const result = await generateImage();

    const submitRequest = fetchRequest(1);
    expect(submitRequest.url).toBe("http://127.0.0.1:8188/prompt");
    expect(submitRequest.auditContext).toBe("comfy-image-generate");
    expect(submitRequest.init?.body).toBe(
      '{"prompt":{"6":{"inputs":{"text":"draw a lobster"}},"9":{"inputs":{}}}}',
    );
    const historyRequest = fetchRequest(2);
    expect(historyRequest.url).toBe("http://127.0.0.1:8188/history/local-prompt-1");
    expect(historyRequest.auditContext).toBe("comfy-history");
    const downloadRequest = fetchRequest(3);
    expect(downloadRequest.url).toBe(
      "http://127.0.0.1:8188/view?filename=generated.png&subfolder=&type=output",
    );
    expect(downloadRequest.auditContext).toBe("comfy-image-download");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "generated.png",
          metadata: {
            nodeId: "9",
            promptId: "local-prompt-1",
          },
        },
      ],
      model: "workflow",
      metadata: {
        promptId: "local-prompt-1",
        outputNodeIds: ["9"],
      },
    });
  });

  it.each([
    ["literal", "Basic fixture", true],
    ["available env", { source: "env", provider: "default", id: "COMFY_HEADER_AVAILABLE" }, true],
    ["missing env", { source: "env", provider: "default", id: "COMFY_HEADER_MISSING" }, false],
    ["file ref", { source: "file", provider: "comfyfile", id: "value" }, true],
  ])("checks %s header availability for every capability", (_label, header, configured) => {
    vi.stubEnv("COMFY_HEADER_AVAILABLE", "Basic fixture");
    vi.stubEnv("COMFY_HEADER_MISSING", undefined);
    for (const [capability, provider] of [
      ["image", buildComfyImageGenerationProvider()],
      ["video", buildComfyVideoGenerationProvider()],
      ["music", buildComfyMusicGenerationProvider()],
    ] as const) {
      const cfg = buildComfyConfig({
        [capability]: testWorkflowConfig(),
        headers: { Authorization: header },
      });
      expect(provider.isConfigured?.({ cfg })).toBe(configured);
    }
  });

  it("injects a fresh custom seed without mutating the workflow", async () => {
    const seedInputName = "noise_seed";
    randomIntMock.mockReturnValueOnce(0).mockReturnValueOnce(2 ** 48 - 2);
    mockLocalImageResponses("seed-prompt-1");
    mockLocalImageResponses("seed-prompt-2");

    const provider = buildComfyImageGenerationProvider();
    const cfg = buildComfyConfig({
      workflow: {
        "4": { inputs: { seed: 0 } },
        "6": { inputs: { text: "" } },
        "9": { inputs: {} },
      },
      promptNodeId: "6",
      outputNodeId: "9",
      seedNodeId: "4",
      seedInputName,
    });

    await provider.generateImage({ provider: "comfy", model: "workflow", prompt: "first", cfg });
    await provider.generateImage({ provider: "comfy", model: "workflow", prompt: "second", cfg });

    const firstSeed = seedFromBody(parseJsonBody(1), "4", seedInputName);
    const secondSeed = seedFromBody(parseJsonBody(4), "4", seedInputName);
    expect(firstSeed).toBe(0);
    expect(secondSeed).toBe(2 ** 48 - 2);
    expect(cfg.plugins?.entries?.comfy?.config?.workflow).toEqual({
      "4": { inputs: { seed: 0 } },
      "6": { inputs: { text: "" } },
      "9": { inputs: {} },
    });
  });

  it("leaves the workflow's baked-in seed untouched when seedNodeId is not configured", async () => {
    mockLocalImageResponses("no-seed-prompt-1");

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig({
        workflow: {
          "4": { inputs: { seed: 12345 } },
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(seedFromBody(parseJsonBody(1), "4")).toBe(12345);
  });

  it("keeps cloud service-discovery hostnames strict without explicit private-network access", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { comfyui: "10.0.0.25" },
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "cloud workflow prompt",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            mode: "cloud",
            apiKey: "comfy-test-key",
            baseUrl: "http://comfyui:8188",
          }),
        ),
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");
    expect(harness.fetchUrls).toEqual([]);
  });

  it("allows local single-label hostnames that resolve to RFC1918 addresses", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { comfyui: "10.0.0.25" },
    });

    const result = await generateImage({
      baseUrl: "http://comfyui:8188",
    });

    expect(harness.guardCalls).toHaveLength(3);
    expect(harness.guardCalls[0]?.url).toBe("http://comfyui:8188/prompt");
    expect(harness.fetchUrls).toContain("http://comfyui:8188/prompt");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-data"));
  });

  it("blocks local public-looking FQDNs resolving private without explicit opt-in", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "images.example.com": "10.0.0.25" },
    });

    await expect(
      generateImage({
        baseUrl: "http://images.example.com:8188",
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");
    expect(harness.guardCalls).toHaveLength(1);
    expect(harness.guardCalls[0]?.url).toBe("http://images.example.com:8188/prompt");
    expect(harness.fetchUrls).toEqual([]);
  });

  it("allows local private-DNS FQDNs with explicit opt-in", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "comfy.private.example.com": "10.0.0.25" },
    });

    const result = await generateImage({
      baseUrl: "http://comfy.private.example.com:8188",
      allowPrivateNetwork: true,
    });

    expect(harness.fetchUrls).toContain("http://comfy.private.example.com:8188/prompt");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-data"));
  });

  it("blocks explicit private-DNS FQDNs resolving to metadata addresses", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "comfy.private.example.com": "169.254.169.254" },
    });

    await expect(
      generateImage({
        baseUrl: "http://comfy.private.example.com:8188",
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");
    expect(harness.fetchUrls).toEqual([]);
  });

  it.each([
    [
      "subdomain",
      "http://assets.comfyui:8188/generated.png",
      { comfyui: "10.0.0.25", "assets.comfyui": "10.0.0.26" },
    ],
    [
      "same hostname private alternate port",
      "http://comfyui:8288/generated.png",
      { comfyui: "10.0.0.25" },
    ],
  ])("blocks local output redirects to %s", async (_label, redirectLocation, dns) => {
    const harness = installRealComfyFetchGuard({
      dns,
      redirectLocation,
    });

    await expect(
      generateImage({
        baseUrl: "http://comfyui:8188",
      }),
    ).rejects.toThrow("Blocked");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it("blocks local public FQDN redirects to other public hosts", async () => {
    const redirectLocation = "https://cdn.example.com/generated.png";
    const harness = installRealComfyFetchGuard({
      dns: {
        "comfy.example.com": "93.184.216.34",
        "cdn.example.com": "93.184.216.35",
      },
      redirectLocation,
    });

    await expect(
      generateImage({
        baseUrl: "https://comfy.example.com",
      }),
    ).rejects.toThrow("Blocked hostname (not in allowlist)");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it.each(["https://private-comfy.example.com", "http://comfyui:8188"])(
    "allows explicit private cloud origin %s redirecting to public CDNs",
    async (baseUrl) => {
      const harness = installRealComfyFetchGuard({
        dns: {
          [new URL(baseUrl).hostname]: "10.0.0.25",
          "cdn.example.com": "93.184.216.34",
        },
        redirectLocation: "https://cdn.example.com/generated.png",
        body: Buffer.from("cdn-data"),
      });

      const result = await generateImage(
        {
          mode: "cloud",
          apiKey: "comfy-test-key",
          baseUrl,
          allowPrivateNetwork: true,
        },
        "cloud workflow prompt",
      );

      expect(harness.fetchUrls).toContain(`${baseUrl}/api/prompt`);
      expect(harness.fetchUrls).toContain("https://cdn.example.com/generated.png");
      expect(harness.guardCalls).toHaveLength(4);
      expect(result.images[0]?.buffer).toEqual(Buffer.from("cdn-data"));
    },
  );

  it.each([
    [
      "private DNS destination",
      "http://other-private.example.com/generated.png",
      {
        "private-comfy.example.com": "10.0.0.25",
        "other-private.example.com": "10.0.0.26",
      },
    ],
    [
      "metadata destination",
      "http://169.254.169.254/latest/meta-data",
      { "private-comfy.example.com": "10.0.0.25" },
    ],
  ])("blocks explicit private cloud redirects to %s", async (_label, redirectLocation, dns) => {
    const harness = installRealComfyFetchGuard({
      dns,
      redirectLocation,
    });

    await expect(
      generateImage(
        {
          mode: "cloud",
          apiKey: "comfy-test-key",
          baseUrl: "https://private-comfy.example.com",
          allowPrivateNetwork: true,
        },
        "cloud workflow prompt",
      ),
    ).rejects.toThrow("Blocked");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it("caps oversized local workflow timeouts", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(MAX_TIMER_TIMEOUT_MS + 1);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "local-prompt-1" }))
      .mockResolvedValueOnce(fetchGuardJson({ "local-prompt-1": { outputs: {} } }));

    try {
      const provider = buildComfyImageGenerationProvider();
      await expect(
        provider.generateImage({
          provider: "comfy",
          model: "workflow",
          prompt: "draw a bounded timer",
          cfg: buildComfyConfig({
            ...testWorkflowConfig(),
            timeoutMs: Number.MAX_SAFE_INTEGER,
          }),
        }),
      ).rejects.toThrow("Comfy workflow did not finish within 2147000s");

      expect(fetchRequest(1).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(fetchRequest(2).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects generated image downloads that exceed the configured media cap", async () => {
    mockLocalImageResponses("local-prompt-1", {
      body: Buffer.from("too-large"),
      contentType: "image/png",
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: {
          ...buildComfyConfig(testWorkflowConfig()),
          agents: { defaults: { mediaMaxMb: 0.000001 } },
        } as never,
      }),
    ).rejects.toThrow("Comfy image output download exceeds 1 bytes");
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

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(testWorkflowConfig()),
      }),
    ).rejects.toThrow("Comfy workflow submit failed: malformed JSON response");
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

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(testWorkflowConfig()),
      }),
    ).rejects.toThrow("Comfy workflow submit failed: JSON response exceeds 16777216 bytes");
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

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "turn this into a poster",
      cfg: buildComfyConfig({
        workflow: {
          "6": { inputs: { text: "" } },
          "7": { inputs: { image: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        inputImageNodeId: "7",
        outputNodeId: "9",
      }),
      inputImages: [
        {
          buffer: Buffer.from("source"),
          mimeType: "image/png",
          fileName: "source.png",
        },
      ],
    });

    const uploadRequest = fetchRequest(1);
    expect(uploadRequest?.url).toBe("http://127.0.0.1:8188/upload/image");
    expect(uploadRequest?.auditContext).toBe("comfy-image-upload");
    expect(uploadRequest?.init?.method).toBe("POST");
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

    const result = await generateImage(
      {
        mode: "cloud",
      },
      "cloud workflow prompt",
    );

    const submitRequest = fetchRequest(1);
    expect(submitRequest?.url).toBe("https://cloud.comfy.org/api/prompt");
    expect(submitRequest?.auditContext).toBe("comfy-image-generate");
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

    const statusRequest = fetchRequest(2);
    expect(statusRequest.url).toBe("https://cloud.comfy.org/api/job/cloud-job-1/status");
    expect(statusRequest.auditContext).toBe("comfy-status");
    const historyRequest = fetchRequest(3);
    expect(historyRequest.url).toBe("https://cloud.comfy.org/api/history_v2/cloud-job-1");
    expect(historyRequest.auditContext).toBe("comfy-history");
    const viewRequest = fetchRequest(4);
    expect(viewRequest.url).toBe(
      "https://cloud.comfy.org/api/view?filename=cloud.png&subfolder=&type=output",
    );
    expect(viewRequest.auditContext).toBe("comfy-image-download");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
    expect(result.metadata).toEqual({
      promptId: "cloud-job-1",
      outputNodeIds: ["9"],
    });
  });

  it("uses plugin config env SecretRef auth for cloud workflows", async () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "cloud-secret-ref-1",
    });

    await generateImage(
      {
        mode: "cloud",
        apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
      },
      "cloud workflow prompt",
    );

    const submitRequest = fetchRequest(1);
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("comfy-secret-ref-key");
    const requestBody = parseJsonBody(1);
    const extraData = requestBody.extra_data as { api_key_comfy_org?: unknown } | undefined;
    expect(extraData?.api_key_comfy_org).toBe("comfy-secret-ref-key");
  });
});
