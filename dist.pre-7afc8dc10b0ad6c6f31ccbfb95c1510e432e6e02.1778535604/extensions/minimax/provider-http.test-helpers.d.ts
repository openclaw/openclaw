import { d as resolveProviderHttpRequestConfig } from "../../provider-http-DBPexlbb.js";
import { r as music_generation_provider_d_exports } from "../../music-generation-provider-Dtr_VmCZ.js";
import { t as Procedure } from "../../index-BnvtB5lR.js";
import { r as video_generation_provider_d_exports } from "../../video-generation-provider-B2fzSpJ3.js";
import * as _$vitest from "vitest";

//#region extensions/minimax/provider-http.test-helpers.d.ts
type ResolveProviderHttpRequestConfigParams = Parameters<typeof resolveProviderHttpRequestConfig>[0];
declare function getMinimaxProviderHttpMocks(): {
  resolveApiKeyForProviderMock: _$vitest.Mock<() => Promise<{
    apiKey: string;
  }>>;
  postJsonRequestMock: _$vitest.Mock<Procedure>;
  fetchWithTimeoutMock: _$vitest.Mock<Procedure>;
  assertOkOrThrowHttpErrorMock: _$vitest.Mock<() => Promise<void>>;
  resolveProviderHttpRequestConfigMock: _$vitest.Mock<(params: ResolveProviderHttpRequestConfigParams) => {
    baseUrl: string;
    allowPrivateNetwork: boolean;
    headers: Headers;
    dispatcherPolicy: undefined;
  }>;
};
declare function installMinimaxProviderHttpMockCleanup(): void;
declare function loadMinimaxMusicGenerationProviderModule(): Promise<typeof music_generation_provider_d_exports>;
declare function loadMinimaxVideoGenerationProviderModule(): Promise<typeof video_generation_provider_d_exports>;
//#endregion
export { getMinimaxProviderHttpMocks, installMinimaxProviderHttpMockCleanup, loadMinimaxMusicGenerationProviderModule, loadMinimaxVideoGenerationProviderModule };