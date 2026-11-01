import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";

/** Both products share endpoint setup, credential persistence, and passive detection. */
export function createLlamaServerAuthMethod(server: LlamaServerIdentity): ProviderAuthMethod {
  const app = server.id !== LLAMA_CPP_SERVER.id;
  return {
    id: "existing-server",
    label: app ? "Llama" : "Existing llama-server",
    hint: app
      ? "Connect to Llama (llama.app) on this Gateway or another host"
      : "Connect to an existing local, private, or remote llama.cpp server",
    kind: "custom",
    wizard: {
      choiceId: app ? server.id : "llama-cpp-existing-server",
      choiceLabel: app ? "Llama" : "Existing llama-server",
      choiceHint: app
        ? "Connect to Llama (llama.app)"
        : "Connect to a llama.cpp server managed outside OpenClaw",
      groupId: server.id,
      groupLabel: app ? "Llama" : "Local llama.cpp",
      groupHint: app ? "Local models with llama.app" : "Managed or external llama.cpp server",
      methodId: "existing-server",
    },
    appGuidedSetup: {
      detect: async (ctx) => (await import("./setup.js")).detectLlamaServerSetup(ctx, server),
      prepare: async (ctx) => (await import("./setup.js")).prepareLlamaServerSetup(ctx, server),
    },
    run: async (ctx) => {
      if (app) {
        await ctx.prompter.note(
          "Get Llama at https://llama.app/, choose and download a model in the app, and enable its API server. Then connect to an address this Gateway can reach. OpenClaw does not install the app or manage its model cache.",
          "Connect Llama",
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
