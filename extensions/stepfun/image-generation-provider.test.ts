import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStepFunImageGenerationProvider,
  buildStepFunPlanImageGenerationProvider,
} from "./image-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  createProviderOperationDeadlineMock,
  resolveProviderOperationTimeoutMsMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "stepfun-key" })),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => params),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.stepfun.ai/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadline: createProviderOperationDeadlineMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequest: vi.fn((request) => request),
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function requireFirstMockObjectArg(mock: ReturnType<typeof vi.fn>, label: string): object {
  const value = requireFirstMockArg(mock, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("stepfun image generation providers", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("registers standard and Step Plan image providers with single-image limits", () => {
    const standardProvider = buildStepFunImageGenerationProvider();
    const planProvider = buildStepFunPlanImageGenerationProvider();

    expect(standardProvider.id).toBe("stepfun");
    expect(planProvider.id).toBe("stepfun-plan");
    expect(standardProvider.defaultModel).toBe("step-image-edit-2");
    expect(planProvider.defaultModel).toBe("step-image-edit-2");
    expect(standardProvider.capabilities.generate.maxCount).toBe(1);
    expect(planProvider.capabilities.generate.maxCount).toBe(1);
    expect(standardProvider.capabilities.edit.maxInputImages).toBe(1);
    expect(planProvider.capabilities.edit.maxInputImages).toBe(1);
  });

  it("sends standard StepFun image generation to the standard images endpoint", async () => {
    const release = vi.fn(async () => {});
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: pngBytes.toString("base64"), finish_reason: "success" }],
        }),
      },
      release,
    });

    const provider = buildStepFunImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "stepfun",
      model: "step-image-edit-2",
      prompt: "snowy cabin at dusk",
      count: 4,
      size: "768x1360",
      cfg: {
        models: {
          providers: {
            stepfun: {
              baseUrl: "https://api.stepfun.ai/v1/",
            },
          },
        },
      } as never,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith({
      baseUrl: "https://api.stepfun.ai/v1",
      defaultBaseUrl: "https://api.stepfun.ai/v1",
      allowPrivateNetwork: false,
      request: undefined,
      defaultHeaders: {
        Authorization: "Bearer stepfun-key",
      },
      provider: "stepfun",
      capability: "image",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const jsonRequest = requireFirstMockArg(postJsonRequestMock, "StepFun JSON image request");
    const jsonHeaders = Reflect.get(jsonRequest ?? {}, "headers");
    expect(jsonHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((jsonHeaders as Headers).entries())).toEqual({
      authorization: "Bearer stepfun-key",
      "content-type": "application/json",
    });
    expect(jsonRequest).toEqual({
      url: "https://api.stepfun.ai/v1/images/generations",
      headers: jsonHeaders,
      timeoutMs: 180_000,
      body: {
        model: "step-image-edit-2",
        prompt: "snowy cabin at dusk",
        n: 1,
        size: "768x1360",
        response_format: "b64_json",
      },
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({
      buffer: pngBytes,
      mimeType: "image/png",
      fileName: "image-1.png",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends Step Plan image edits to the Step Plan images endpoint", async () => {
    postMultipartRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [
            {
              b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
                "base64",
              ),
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildStepFunPlanImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "stepfun-plan",
      model: "step-image-edit-2",
      prompt: "turn this sketch into a watercolor poster",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/webp" }],
      cfg: {
        models: {
          providers: {
            "stepfun-plan": {
              baseUrl: "https://api.stepfun.ai/step_plan/v1/",
            },
          },
        },
      } as never,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith({
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      defaultBaseUrl: "https://api.stepfun.ai/step_plan/v1",
      allowPrivateNetwork: false,
      request: undefined,
      defaultHeaders: {
        Authorization: "Bearer stepfun-key",
      },
      provider: "stepfun-plan",
      capability: "image",
      transport: "http",
    });
    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const multipartRequest = requireFirstMockObjectArg(
      postMultipartRequestMock,
      "Step Plan multipart image request",
    );
    const multipartHeaders = Reflect.get(multipartRequest, "headers");
    expect(multipartHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((multipartHeaders as Headers).entries())).toEqual({
      authorization: "Bearer stepfun-key",
    });
    const form = Reflect.get(multipartRequest, "body") as FormData;
    expect(multipartRequest).toEqual({
      url: "https://api.stepfun.ai/step_plan/v1/images/edits",
      headers: multipartHeaders,
      body: form,
      timeoutMs: 180_000,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(form.get("model")).toBe("step-image-edit-2");
    expect(form.get("prompt")).toBe("turn this sketch into a watercolor poster");
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("image")).toBeInstanceOf(File);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
  });
});
