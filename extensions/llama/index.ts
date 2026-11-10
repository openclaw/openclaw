import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { LLAMA_PROVIDER_LABEL } from "./defaults.js";
import llamaProvider from "./provider-discovery.js";

const setup = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./setup.js")));

export default definePluginEntry({
  id: "llama",
  name: "Llama Provider",
  description: "Local models from the Llama app, llama.cpp's desktop app",
  register(api) {
    api.registerProvider({
      ...llamaProvider,
      // The app runs llama-server, so tool schemas need its GBNF grammar cleanup.
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      auth: [
        {
          id: "local",
          label: LLAMA_PROVIDER_LABEL,
          hint: "Connect to the running Llama app",
          kind: "custom",
          appGuidedSetup: {
            detect: setup((mod) => mod.detectLlama),
            prepare: setup((mod) => mod.prepareLlama),
          },
          run: setup((mod) => mod.configureLlamaInteractive),
          validateNonInteractive: setup((mod) => mod.validateLlamaNonInteractive),
          runNonInteractive: setup((mod) => mod.configureLlamaNonInteractive),
        },
      ],
      wizard: {
        setup: {
          choiceId: "llama",
          choiceLabel: LLAMA_PROVIDER_LABEL,
          choiceHint: "Connect to the running Llama app",
          groupId: "llama",
          groupLabel: LLAMA_PROVIDER_LABEL,
          groupHint: "Local models from llama.cpp's desktop app",
          methodId: "local",
        },
        modelPicker: {
          label: LLAMA_PROVIDER_LABEL,
          hint: "Discover models from the Llama app",
          methodId: "local",
        },
      },
    });
  },
});
