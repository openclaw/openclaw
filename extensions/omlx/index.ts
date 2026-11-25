import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { OMLX_LOCAL_API_KEY } from "./defaults.js";
import { omlxEmbeddingProvider } from "./memory-embedding-adapter.js";
import omlxProvider from "./provider-discovery.js";

const setup = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./setup.js")));

export default definePluginEntry({
  id: "omlx",
  name: "oMLX Provider",
  description: "Local Apple Silicon chat and memory embeddings through oMLX",
  register(api) {
    api.registerEmbeddingProvider(omlxEmbeddingProvider);
    api.registerProvider({
      ...omlxProvider,
      auth: [
        {
          id: "local",
          label: "oMLX",
          hint: "Connect to an oMLX server on Apple Silicon",
          kind: "custom",
          appGuidedSetup: {
            detectAvailability: setup((mod) => mod.detectOmlxAvailability),
            detect: setup((mod) => mod.detectOmlx),
            prepare: setup((mod) => mod.prepareOmlx),
          },
          run: setup((mod) => mod.configureOmlxInteractive),
          validateNonInteractive: setup((mod) => mod.validateOmlxNonInteractive),
          runNonInteractive: setup((mod) => mod.configureOmlxNonInteractive),
        },
      ],
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey === OMLX_LOCAL_API_KEY,
      wizard: {
        setup: {
          choiceId: "omlx",
          choiceLabel: "oMLX",
          choiceHint: "Local Apple Silicon server",
          groupId: "omlx",
          groupLabel: "oMLX",
          groupHint: "Local chat and memory embeddings",
          methodId: "local",
        },
        modelPicker: {
          label: "oMLX",
          hint: "Discover models from the oMLX server",
          methodId: "local",
        },
      },
    });
  },
});
