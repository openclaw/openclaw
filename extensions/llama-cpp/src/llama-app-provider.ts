import type {
  OpenClawPluginApi,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { llamaAppProviderDiscovery } from "../provider-discovery.js";
import { LLAMA_APP_SERVER } from "./external-server/defaults.js";
import { createLlamaServerAuthMethod } from "./external-server/registration.js";

export function registerLlamaAppProvider(api: OpenClawPluginApi): void {
  const wrapStream =
    (ctx: ProviderWrapStreamFnContext) =>
    async (...args: Parameters<NonNullable<typeof ctx.streamFn>>) => {
      const { wrapLlamaServerStream } = await import("./external-server/stream.js");
      return wrapLlamaServerStream(ctx, LLAMA_APP_SERVER)(...args);
    };
  api.registerProvider({
    ...llamaAppProviderDiscovery,
    auth: [createLlamaServerAuthMethod(LLAMA_APP_SERVER)],
    prepareDynamicModel: async (ctx) =>
      (await import("./external-server/provider.js")).prepareLlamaServerDynamicModel(
        ctx,
        LLAMA_APP_SERVER,
      ),
    wrapSimpleCompletionStreamFn: wrapStream,
    wrapStreamFn: wrapStream,
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    wizard: {
      modelPicker: {
        label: "Llama",
        hint: "Connect to Llama (llama.app) at http://127.0.0.1:9931",
        methodId: "existing-server",
      },
    },
  });
}
