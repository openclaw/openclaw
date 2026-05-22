import { h as resolveProviderHttpRequestConfig } from "../../provider-http-B4duRoh8.js";
import { r as music_generation_provider_d_exports } from "../../music-generation-provider-DQXLb08L.js";
import { r as video_generation_provider_d_exports } from "../../video-generation-provider-CMA-pW7r.js";
import { Mock } from "vitest";

//#region extensions/minimax/provider-http.test-helpers.d.ts
type ResolveProviderHttpRequestConfigParams = Parameters<typeof resolveProviderHttpRequestConfig>[0];
type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: undefined;
};
type AnyMock = Mock<(...args: any[]) => any>;
interface MinimaxProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{
    apiKey: string;
  }>>;
  postJsonRequestMock: AnyMock;
  fetchWithTimeoutMock: AnyMock;
  fetchProviderOperationResponseMock: AnyMock;
  fetchProviderDownloadResponseMock: AnyMock;
  assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  resolveProviderHttpRequestConfigMock: Mock<(params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult>;
}
declare function getMinimaxProviderHttpMocks(): MinimaxProviderHttpMocks;
declare function installMinimaxProviderHttpMockCleanup(): void;
declare function loadMinimaxMusicGenerationProviderModule(): Promise<typeof music_generation_provider_d_exports>;
declare function loadMinimaxVideoGenerationProviderModule(): Promise<typeof video_generation_provider_d_exports>;
//#endregion
export { getMinimaxProviderHttpMocks, installMinimaxProviderHttpMockCleanup, loadMinimaxMusicGenerationProviderModule, loadMinimaxVideoGenerationProviderModule };