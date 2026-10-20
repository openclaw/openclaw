import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import * as cli from "./cli.js";
import { promptTenantId, testFoundryConnection } from "./onboard.js";
import { ANTHROPIC_MESSAGES_API, DEFAULT_API, DEFAULT_GPT5_API } from "./shared.js";

const hoisted = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

const endpoint = "https://example.services.ai.azure.com";
const messages = [{ role: "user", content: "hi" }];

function connect(
  note = vi.fn(),
  overrides: Partial<Parameters<typeof testFoundryConnection>[0]> = {},
) {
  return testFoundryConnection({
    ctx: { prompter: { note } } as never,
    endpoint: "https://example.openai.azure.com",
    modelId: "gpt-4o",
    api: DEFAULT_API,
    ...overrides,
  });
}

function respond(response: Response, release = vi.fn(async () => {})) {
  hoisted.fetchWithSsrFGuard.mockResolvedValue({ response, release });
  return release;
}

describe("testFoundryConnection", () => {
  beforeEach(() => {
    vi.spyOn(cli, "getAccessTokenResult").mockReturnValue({ accessToken: "token" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    hoisted.fetchWithSsrFGuard.mockReset();
  });

  it.each([
    [
      DEFAULT_GPT5_API,
      endpoint,
      "gpt-5.4",
      "gpt-5.4",
      "/openai/v1/responses",
      { model: "gpt-5.4", input: "hi", max_output_tokens: 16 },
      {},
    ],
    [
      DEFAULT_API,
      endpoint,
      "FW-GLM-5",
      "FW-GLM-5",
      "/openai/v1/chat/completions",
      { model: "FW-GLM-5", messages, max_tokens: 1 },
      {},
    ],
    [
      ANTHROPIC_MESSAGES_API,
      `${endpoint}/openai/v1`,
      "prod-fable",
      "claude-fable-5",
      "/anthropic/v1/messages",
      { model: "prod-fable", messages, max_tokens: 1, thinking: { type: "adaptive" } },
      { "anthropic-version": "2023-06-01" },
    ],
  ] as const)(
    "sends the %s connection request through the guarded transport",
    async (api, inputEndpoint, modelId, modelNameHint, urlPath, body, headers) => {
      const release = respond(new Response(null, { status: 200 }));
      await connect(vi.fn(), { endpoint: inputEndpoint, modelId, modelNameHint, api });

      const request = hoisted.fetchWithSsrFGuard.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        url: `${endpoint}${urlPath}`,
        timeoutMs: 15_000,
        init: { method: "POST", body: JSON.stringify(body) },
      });
      expect(new Headers(request?.init?.headers)).toEqual(
        new Headers({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
          ...headers,
        }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds connection-test error bodies without using response.text()", async () => {
    const note = vi.fn();
    const tracked = cancelTrackedTextResponse(`${"foundry failure ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    respond(tracked.response);
    await connect(note);

    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Warning: test request returned 503"),
      "Connection Test",
    );
  });

  it.each([
    {
      status: 400,
      expectedPrefix:
        "Endpoint is reachable but returned 400 Bad Request - check your deployment name and API version.\n",
      expectedSuffix: "",
    },
    {
      status: 503,
      expectedPrefix: "Warning: test request returned 503. ",
      expectedSuffix: "\nProceeding anyway - you can fix the endpoint later.",
    },
  ])(
    "keeps $status error-body previews UTF-16 safe",
    async ({ status, expectedPrefix, expectedSuffix }) => {
      const note = vi.fn();
      const prefix = "x".repeat(199);
      respond(new Response(`${prefix}😀tail`, { status }));
      await connect(note);

      expect(note).toHaveBeenCalledExactlyOnceWith(
        `${expectedPrefix}${prefix}${expectedSuffix}`,
        "Connection Test",
      );
    },
  );
});

it("validates tenant domains and UUIDs through the prompt boundary", async () => {
  const text = vi.fn(async (options: { validate?: (value: string) => string | undefined }) => {
    expect(options.validate?.(" contoso.onmicrosoft.com ")).toBeUndefined();
    expect(options.validate?.("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(options.validate?.("not a tenant")).toBe("Enter a valid tenant ID or tenant domain");
    expect(options.validate?.("")).toBe("Tenant ID is required");
    return " contoso.onmicrosoft.com ";
  });

  await expect(promptTenantId({ prompter: { text } } as never, { required: true })).resolves.toBe(
    "contoso.onmicrosoft.com",
  );
  expect(text).toHaveBeenCalledTimes(1);
});
