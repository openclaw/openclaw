import { o as SearchConfigRecord } from "../../provider-web-search-DnjA_Z1w.js";
import { n as buildMinimaxPortalImageGenerationProvider, t as buildMinimaxImageGenerationProvider } from "../../image-generation-provider-CoYJQiPT.js";
import { n as minimaxPortalMediaUnderstandingProvider, t as minimaxMediaUnderstandingProvider } from "../../media-understanding-provider-DJWSqYGS.js";
import { t as buildMinimaxMusicGenerationProvider } from "../../music-generation-provider-BzSMZ0DF.js";
import { n as buildMinimaxVideoGenerationProvider } from "../../video-generation-provider-CeYppKSl.js";

//#region extensions/minimax/src/minimax-web-search-provider.runtime.d.ts
declare function resolveMiniMaxApiKey(searchConfig?: SearchConfigRecord): string | undefined;
declare function resolveMiniMaxRegion(searchConfig?: SearchConfigRecord, config?: Record<string, unknown>): "cn" | "global";
declare function resolveMiniMaxEndpoint(searchConfig?: SearchConfigRecord, config?: Record<string, unknown>): string;
declare const __testing: {
  readonly MINIMAX_SEARCH_ENDPOINT_GLOBAL: "https://api.minimax.io/v1/coding_plan/search";
  readonly MINIMAX_SEARCH_ENDPOINT_CN: "https://api.minimaxi.com/v1/coding_plan/search";
  readonly resolveMiniMaxApiKey: typeof resolveMiniMaxApiKey;
  readonly resolveMiniMaxEndpoint: typeof resolveMiniMaxEndpoint;
  readonly resolveMiniMaxRegion: typeof resolveMiniMaxRegion;
};
//#endregion
export { buildMinimaxImageGenerationProvider, buildMinimaxMusicGenerationProvider, buildMinimaxPortalImageGenerationProvider, buildMinimaxVideoGenerationProvider, minimaxMediaUnderstandingProvider, minimaxPortalMediaUnderstandingProvider, __testing as minimaxWebSearchTesting };