import { a as Model, c as StreamFunction, i as Context, l as StreamOptions, r as AssistantMessageEventStreamContract, s as SimpleStreamOptions, t as Api } from "./index-Cut3wAt0.mjs";

//#region packages/llm-runtime/src/api-registry.d.ts
type ApiStreamFunction = (model: Model, context: Context, options?: StreamOptions) => AssistantMessageEventStreamContract;
type ApiStreamSimpleFunction = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStreamContract;
interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
interface ApiProviderInternal {
  api: Api;
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
}
declare function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(provider: ApiProvider<TApi, TOptions>, sourceId?: string): void;
declare function getApiProvider(api: Api): ApiProviderInternal | undefined;
declare function getApiProviders(): ApiProviderInternal[];
declare function unregisterApiProviders(sourceId: string): void;
declare function clearApiProviders(): void;
//#endregion
export { ApiProvider, ApiStreamFunction, ApiStreamSimpleFunction, clearApiProviders, getApiProvider, getApiProviders, registerApiProvider, unregisterApiProviders };