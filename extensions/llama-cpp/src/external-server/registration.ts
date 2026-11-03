import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";

/** Both products share endpoint setup, credential persistence, and passive detection. */
export function createLlamaServerAuthMethod(server: LlamaServerIdentity): ProviderAuthMethod {
  const app = server.id !== LLAMA_CPP_SERVER.id;
  return {
    id: "existing-server",
    label: app ? server.label : "Existing llama.cpp server",
    hint: app
      ? "Use models from the separate Llama app (llama.app)."
      : "Connect to a llama.cpp server you already run.",
    kind: "custom",
    wizard: {
      choiceId: app ? server.id : "llama-cpp-existing-server",
      choiceLabel: app ? server.label : "Existing llama.cpp server",
      choiceHint: app
        ? "Use models from the separate Llama app (llama.app)."
        : "Connect to a llama.cpp server you already run.",
      groupId: server.id,
      groupLabel: app ? server.label : "llama.cpp",
      groupHint: app
        ? "Models managed by the Llama app"
        : "Built-in local AI or a server you already run",
      methodId: "existing-server",
    },
    appGuidedSetup: {
      detect: async (ctx) => (await import("./setup.js")).detectLlamaServerSetup(ctx, server),
      prepare: async (ctx) => (await import("./setup.js")).prepareLlamaServerSetup(ctx, server),
    },
    run: async (ctx) => {
      if (app) {
        await ctx.prompter.note(
          "Get Llama app at https://llama.app/, choose and download a model in the app, and enable its API server. Then connect to an address this Gateway can reach. OpenClaw does not install the app or manage its model cache.",
          "Set up Llama app",
        );
      }
      return (await import("./setup.js")).runLlamaServerSetup(ctx, server);
    },
    validateNonInteractive: async (ctx) =>
      (await import("./setup.js")).validateLlamaServerNonInteractive(ctx, server),
    runNonInteractive: async (ctx) =>
      (await import("./setup.js")).configureLlamaServerNonInteractive(ctx, server),
  };
}
