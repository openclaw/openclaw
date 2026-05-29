import { a as Model, i as Context, n as AssistantMessage, o as ProviderStreamOptions, r as AssistantMessageEventStreamContract, s as SimpleStreamOptions, t as Api } from "./index-Cut3wAt0.mjs";

//#region packages/llm-runtime/src/stream.d.ts
declare function stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): AssistantMessageEventStreamContract;
declare function complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage>;
declare function streamSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStreamContract;
declare function completeSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
//#endregion
export { complete, completeSimple, stream, streamSimple };