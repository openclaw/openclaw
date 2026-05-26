import { h as resolveProviderHttpRequestConfig } from "../../provider-http-ByynA2MJ.js";
import { r as music_generation_provider_d_exports } from "../../music-generation-provider-BOkZNHAi.js";
import { r as video_generation_provider_d_exports } from "../../video-generation-provider-Cd2cCE-M.js";
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