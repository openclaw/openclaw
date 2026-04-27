import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import { createAzureOpenAIResponsesTransportStreamFn, createOpenAICompletionsTransportStreamFn, createOpenAIResponsesTransportStreamFn, } from "./openai-transport-stream.js";
import { getModelProviderRequestTransport } from "./provider-request-config.js";
const SUPPORTED_TRANSPORT_APIS = new Set([
    "openai-responses",
    "openai-codex-responses",
    "openai-completions",
    "azure-openai-responses",
    "anthropic-messages",
    "google-generative-ai",
]);
const SIMPLE_TRANSPORT_API_ALIAS = {
    "openai-responses": "openclaw-openai-responses-transport",
    "openai-codex-responses": "openclaw-openai-responses-transport",
    "openai-completions": "openclaw-openai-completions-transport",
    "azure-openai-responses": "openclaw-azure-openai-responses-transport",
    "anthropic-messages": "openclaw-anthropic-messages-transport",
    "google-generative-ai": "openclaw-google-generative-ai-transport",
};
function createProviderOwnedGoogleTransportStreamFn(model, ctx) {
    return (resolveProviderStreamFn({
        provider: model.provider,
        config: ctx?.cfg,
        workspaceDir: ctx?.workspaceDir,
        env: ctx?.env,
        context: {
            config: ctx?.cfg,
            agentDir: ctx?.agentDir,
            workspaceDir: ctx?.workspaceDir,
            provider: model.provider,
            modelId: model.id,
            model,
        },
    }) ??
        resolveProviderStreamFn({
            provider: "google",
            config: ctx?.cfg,
            workspaceDir: ctx?.workspaceDir,
            env: ctx?.env,
            context: {
                config: ctx?.cfg,
                agentDir: ctx?.agentDir,
                workspaceDir: ctx?.workspaceDir,
                provider: model.provider,
                modelId: model.id,
                model,
            },
        }) ??
        undefined);
}
function createSupportedTransportStreamFn(model, ctx) {
    switch (model.api) {
        case "openai-responses":
        case "openai-codex-responses":
            return createOpenAIResponsesTransportStreamFn();
        case "openai-completions":
            return createOpenAICompletionsTransportStreamFn();
        case "azure-openai-responses":
            return createAzureOpenAIResponsesTransportStreamFn();
        case "anthropic-messages":
            return createAnthropicMessagesTransportStreamFn();
        case "google-generative-ai":
            return createProviderOwnedGoogleTransportStreamFn(model, ctx);
        default:
            return undefined;
    }
}
function hasTransportOverrides(model) {
    const request = getModelProviderRequestTransport(model);
    return Boolean(request?.proxy || request?.tls);
}
export function isTransportAwareApiSupported(api) {
    return SUPPORTED_TRANSPORT_APIS.has(api);
}
export function resolveTransportAwareSimpleApi(api) {
    return SIMPLE_TRANSPORT_API_ALIAS[api];
}
export function createTransportAwareStreamFnForModel(model, ctx) {
    if (!hasTransportOverrides(model)) {
        return undefined;
    }
    if (!isTransportAwareApiSupported(model.api)) {
        throw new Error(`Model-provider request.proxy/request.tls is not yet supported for api "${model.api}"`);
    }
    return createSupportedTransportStreamFn(model, ctx);
}
export function createBoundaryAwareStreamFnForModel(model, ctx) {
    if (!isTransportAwareApiSupported(model.api)) {
        return undefined;
    }
    return createSupportedTransportStreamFn(model, ctx);
}
export function prepareTransportAwareSimpleModel(model, ctx) {
    const streamFn = createTransportAwareStreamFnForModel(model, ctx);
    const alias = resolveTransportAwareSimpleApi(model.api);
    if (!streamFn || !alias) {
        return model;
    }
    return {
        ...model,
        api: alias,
    };
}
export function buildTransportAwareSimpleStreamFn(model, ctx) {
    return createTransportAwareStreamFnForModel(model, ctx);
}
