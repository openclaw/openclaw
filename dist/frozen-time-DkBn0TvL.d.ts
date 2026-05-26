import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { s as VideoGenerationProvider } from "./types-Dcgt3eyW.js";
import { execFileSync } from "node:child_process";
import { Api, Model, completeSimple } from "@earendil-works/pi-ai";
import { ServerResponse } from "node:http";
import { vi } from "vitest";

//#region src/media-understanding/audio.test-helpers.d.ts
declare function installPinnedHostnameTestHooks(): void;
declare function createAuthCaptureJsonFetch(responseBody: unknown): {
  fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
    preconnect: (url: string | URL, options?: {
      dns?: boolean;
      tcp?: boolean;
      http?: boolean;
      https?: boolean;
    }) => void;
    __openclawAcceptsDispatcher: true;
  };
  getAuthHeader: () => string | null;
};
declare function createRequestCaptureJsonFetch(responseBody: unknown): {
  fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
    preconnect: (url: string | URL, options?: {
      dns?: boolean;
      tcp?: boolean;
      http?: boolean;
      https?: boolean;
    }) => void;
    __openclawAcceptsDispatcher: true;
  };
  getRequest: () => {
    url: string | null;
    init: RequestInit | undefined;
  };
};
//#endregion
//#region src/agents/live-test-helpers.d.ts
declare function isLiveTestEnabled(extraEnvVars?: readonly string[], env?: NodeJS.ProcessEnv): boolean;
declare function isLiveProfileKeyModeEnabled(env?: NodeJS.ProcessEnv): boolean;
declare function createSingleUserPromptMessage(content?: string): {
  role: "user";
  content: string;
  timestamp: number;
}[];
declare function extractNonEmptyAssistantText(content: Array<{
  type?: string;
  text?: string;
}>): string;
//#endregion
//#region src/agents/live-auth-keys.d.ts
type CollectProviderApiKeysOptions = {
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: readonly string[];
};
declare function collectProviderApiKeys(provider: string, options?: CollectProviderApiKeysOptions): string[];
//#endregion
//#region src/test-utils/generation-live-test-helpers.d.ts
declare function maybeLoadShellEnvForGenerationProviders(providerIds: string[]): void;
//#endregion
//#region src/infra/shell-env.d.ts
declare function getShellEnvAppliedKeys(): string[];
//#endregion
//#region src/media-generation/live-test-helpers.d.ts
declare function redactLiveApiKey(value: string | undefined): string;
declare function parseLiveCsvFilter(raw?: string, options?: {
  lowercase?: boolean;
}): Set<string> | null;
declare function parseProviderModelMap(raw?: string): Map<string, string>;
//#endregion
//#region src/music-generation/live-test-helpers.d.ts
declare const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string>;
declare function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string>;
declare function resolveLiveMusicAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}): AuthProfileStore | undefined;
//#endregion
//#region src/video-generation/live-test-helpers.d.ts
declare const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string>;
declare function resolveLiveVideoResolution(params: {
  providerId: string;
  modelRef: string;
}): "480P" | "720P" | "768P" | "1080P";
declare function resolveConfiguredLiveVideoModels(cfg: OpenClawConfig): Map<string, string>;
declare function canRunBufferBackedVideoToVideoLiveLane(params: {
  providerId: string;
  modelRef: string;
}): boolean;
declare function canRunBufferBackedImageToVideoLiveLane(params: {
  providerId: string;
  modelRef: string;
}): boolean;
declare function resolveLiveVideoAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}): AuthProfileStore | undefined;
//#endregion
//#region src/video-generation/duration-support.d.ts
declare function normalizeVideoGenerationDuration(params: {
  provider?: VideoGenerationProvider;
  model?: string;
  durationSeconds?: number;
  inputImageCount?: number;
  inputVideoCount?: number;
}): number | undefined;
//#endregion
//#region src/test-helpers/http.d.ts
declare function jsonResponse(body: unknown, status?: number): Response;
declare function requestUrl(input: string | URL | Request): string;
declare function requestBodyText(body: BodyInit | null | undefined): string;
//#endregion
//#region src/test-helpers/ssrf.d.ts
declare function mockPinnedHostnameResolution(addresses?: string[]): {
  mockRestore: () => void;
};
//#endregion
//#region src/test-helpers/windows-cmd-shim.d.ts
declare function createWindowsCmdShimFixture(params: {
  shimPath: string;
  scriptPath: string;
  shimLine: string;
}): Promise<void>;
//#endregion
//#region src/test-utils/provider-usage-fetch.d.ts
type UsageFetchInput = string | Request | URL;
type UsageFetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
type UsageFetchMock = ReturnType<typeof vi.fn<(input: UsageFetchInput, init?: RequestInit) => Promise<Response>>>;
declare function makeResponse(status: number, body: unknown): Response;
declare function createProviderUsageFetch(handler: UsageFetchHandler): typeof fetch & UsageFetchMock;
//#endregion
//#region src/test-helpers/state-dir-env.d.ts
declare function withStateDirEnv<T>(prefix: string, fn: (ctx: {
  tempRoot: string;
  stateDir: string;
}) => Promise<T>): Promise<T>;
//#endregion
//#region src/test-utils/env.d.ts
declare function captureEnv(keys: string[]): {
  restore(): void;
};
declare function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T;
declare function withEnvAsync<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T>;
//#endregion
//#region src/test-utils/fetch-mock.d.ts
type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchPreconnectOptions = {
  dns?: boolean;
  tcp?: boolean;
  http?: boolean;
  https?: boolean;
};
type FetchWithPreconnect = {
  preconnect: (url: string | URL, options?: FetchPreconnectOptions) => void;
  __openclawAcceptsDispatcher: true;
};
declare function withFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
declare function withFetchPreconnect<T extends object>(fn: T): T & FetchWithPreconnect & typeof fetch;
//#endregion
//#region src/test-utils/mock-http-response.d.ts
declare function createMockServerResponse(): ServerResponse & {
  body?: string;
};
//#endregion
//#region src/test-utils/temp-home.d.ts
type TempHomeEnv = {
  home: string;
  restore: () => Promise<void>;
};
declare function createTempHomeEnv(prefix: string): Promise<TempHomeEnv>;
//#endregion
//#region src/test-utils/temp-dir.d.ts
declare function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T>;
//#endregion
//#region src/test-utils/frozen-time.d.ts
declare function useFrozenTime(at: string | number | Date): void;
declare function useRealTime(): void;
//#endregion
export { parseLiveCsvFilter as A, createAuthCaptureJsonFetch as B, canRunBufferBackedVideoToVideoLiveLane as C, DEFAULT_LIVE_MUSIC_MODELS as D, resolveLiveVideoResolution as E, collectProviderApiKeys as F, installPinnedHostnameTestHooks as H, createSingleUserPromptMessage as I, extractNonEmptyAssistantText as L, redactLiveApiKey as M, getShellEnvAppliedKeys as N, resolveConfiguredLiveMusicModels as O, maybeLoadShellEnvForGenerationProviders as P, isLiveProfileKeyModeEnabled as R, canRunBufferBackedImageToVideoLiveLane as S, resolveLiveVideoAuthStore as T, createRequestCaptureJsonFetch as V, jsonResponse as _, createTempHomeEnv as a, normalizeVideoGenerationDuration as b, withFetchPreconnect as c, withEnvAsync as d, withStateDirEnv as f, mockPinnedHostnameResolution as g, createWindowsCmdShimFixture as h, TempHomeEnv as i, parseProviderModelMap as j, resolveLiveMusicAuthStore as k, captureEnv as l, makeResponse as m, useRealTime as n, createMockServerResponse as o, createProviderUsageFetch as p, withTempDir as r, FetchMock as s, useFrozenTime as t, withEnv as u, requestBodyText as v, resolveConfiguredLiveVideoModels as w, DEFAULT_LIVE_VIDEO_MODELS as x, requestUrl as y, isLiveTestEnabled as z };