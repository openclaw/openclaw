/** Lazy registration facade for Codex-backed media understanding. */
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { CODEX_PROVIDER_ID, FALLBACK_CODEX_MODELS } from "./provider-catalog.js";
import type { CodexAppServerClientLeaseFactory } from "./src/app-server/shared-client.js";

const DEFAULT_CODEX_IMAGE_MODEL =
  FALLBACK_CODEX_MODELS.find((model) => model.inputModalities.includes("image"))?.id ??
  FALLBACK_CODEX_MODELS[0]?.id;

/** Dependencies and plugin config for Codex media-understanding calls. */
export type CodexMediaUnderstandingProviderOptions = {
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  clientLeaseFactory?: CodexAppServerClientLeaseFactory;
};

/** Builds a provider whose app-server implementation loads on first use. */
export function buildCodexMediaUnderstandingProvider(
  options: CodexMediaUnderstandingProviderOptions = {},
): MediaUnderstandingProvider {
  let runtime: Promise<typeof import("./src/media-understanding-provider.runtime.js")> | undefined;
  const load = () => (runtime ??= import("./src/media-understanding-provider.runtime.js"));
  return {
    id: CODEX_PROVIDER_ID,
    capabilities: ["image"],
    ...(DEFAULT_CODEX_IMAGE_MODEL ? { defaultModels: { image: DEFAULT_CODEX_IMAGE_MODEL } } : {}),
    describeImage: async ({ buffer, fileName, mime, ...request }) =>
      await (
        await load()
      ).describeCodexImages({ ...request, images: [{ buffer, fileName, mime }] }, options),
    describeImages: async (request) => await (await load()).describeCodexImages(request, options),
    extractStructured: async (request) =>
      await (await load()).extractCodexStructured(request, options),
  };
}
