import { o as SearchConfigRecord } from "../../provider-web-search-DcNMGSex.js";
import { n as buildMinimaxPortalImageGenerationProvider, t as buildMinimaxImageGenerationProvider } from "../../image-generation-provider-DebBMYM6.js";
import { n as minimaxPortalMediaUnderstandingProvider, t as minimaxMediaUnderstandingProvider } from "../../media-understanding-provider-D_cE-sDN.js";
import { t as buildMinimaxMusicGenerationProvider } from "../../music-generation-provider-BOkZNHAi.js";
import { n as buildMinimaxVideoGenerationProvider } from "../../video-generation-provider-Cd2cCE-M.js";

//#region extensions/minimax/src/minimax-web-search-provider.runtime.d.ts
type MiniMaxSearchResult = {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
};
type MiniMaxRelatedSearch = {
  query?: string;
};
type MiniMaxSearchResponse = {
  organic?: MiniMaxSearchResult[];
  related_searches?: MiniMaxRelatedSearch[];
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};
declare function resolveMiniMaxApiKey(searchConfig?: SearchConfigRecord): string | undefined;
declare function resolveMiniMaxRegion(searchConfig?: SearchConfigRecord, config?: Record<string, unknown>): "cn" | "global";
declare function resolveMiniMaxEndpoint(searchConfig?: SearchConfigRecord, config?: Record<string, unknown>): string;
declare const testing: {
  readonly MINIMAX_SEARCH_ENDPOINT_GLOBAL: "https://api.minimax.io/v1/coding_plan/search";
  readonly MINIMAX_SEARCH_ENDPOINT_CN: "https://api.minimaxi.com/v1/coding_plan/search";
  readonly resolveMiniMaxApiKey: typeof resolveMiniMaxApiKey;
  readonly resolveMiniMaxEndpoint: typeof resolveMiniMaxEndpoint;
  readonly resolveMiniMaxRegion: typeof resolveMiniMaxRegion;
  readonly readMiniMaxSearchJsonResponse: (response: Response, label: string) => Promise<MiniMaxSearchResponse>;
};
//#endregion
export { buildMinimaxImageGenerationProvider, buildMinimaxMusicGenerationProvider, buildMinimaxPortalImageGenerationProvider, buildMinimaxVideoGenerationProvider, minimaxMediaUnderstandingProvider, minimaxPortalMediaUnderstandingProvider, testing as minimaxWebSearchTesting };