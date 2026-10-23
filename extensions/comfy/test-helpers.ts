import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createCapturedPluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { expect, vi } from "vitest";
import plugin from "./index.js";

type FetchGuardMock = ReturnType<typeof vi.fn>;

type FetchGuardRequest = { init?: { body?: unknown } };

type ComfyCloudJobResponseOptions = {
  body: BodyInit;
  contentType: string;
  filename: string;
  outputKind: "gifs" | "images";
  promptId: string;
};

export function registerComfyProviders() {
  const captured = createCapturedPluginRegistration();
  plugin.register(captured.api);
  return {
    image: requireRegisteredProvider(captured.imageGenerationProviders, "comfy"),
    music: requireRegisteredProvider(captured.musicGenerationProviders, "comfy"),
    video: requireRegisteredProvider(captured.videoGenerationProviders, "comfy"),
  };
}

export function buildComfyConfig(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { comfy: { config } } } } as unknown as OpenClawConfig;
}

export function buildLegacyComfyConfig(config: Record<string, unknown>): OpenClawConfig {
  return { models: { providers: { comfy: config } } } as unknown as OpenClawConfig;
}

export function parseComfyJsonBody(
  fetchWithSsrFGuardMock: FetchGuardMock,
  call: number,
): Record<string, unknown> {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0] as FetchGuardRequest | undefined;
  const body = request?.init?.body;
  expect(body).toBeTruthy();
  if (typeof body !== "string") {
    throw new Error(`Missing Comfy request body for fetch call ${call}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

export function mockComfyProviderApiKey(apiKey = "comfy-test-key") {
  return vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey,
    source: "env",
    mode: "api-key",
  });
}

export function mockComfyCloudJobResponses(
  fetchWithSsrFGuardMock: FetchGuardMock,
  options: ComfyCloudJobResponseOptions,
) {
  const output = { filename: options.filename, subfolder: "", type: "output" };
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(fetchGuardJson({ prompt_id: options.promptId }))
    .mockResolvedValueOnce(fetchGuardJson({ status: "completed" }))
    .mockResolvedValueOnce(
      fetchGuardJson({
        [options.promptId]: {
          outputs: { "9": { [options.outputKind]: [output] } },
        },
      }),
    )
    .mockResolvedValueOnce(fetchGuardResponse(options.body, options.contentType));
}

export function fetchGuardJson(body: unknown) {
  return fetchGuardResponse(JSON.stringify(body), "application/json");
}

function fetchGuardResponse(body: BodyInit, contentType: string) {
  return {
    response: new Response(body, { status: 200, headers: { "content-type": contentType } }),
    release: vi.fn(async () => {}),
  };
}
