import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
export declare function resolveForwardCompatModel(provider: string, modelId: string, modelRegistry: ModelRegistry): Model<Api> | undefined;
