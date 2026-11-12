import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { RAPID_MLX_LOCAL_API_KEY } from "./defaults.js";
import { rapidMlxEmbeddingProvider } from "./memory-embedding-adapter.js";
import rapidMlxProvider from "./provider-discovery.js";

const setup = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./setup.js")));

export default definePluginEntry({
  id: "rapid-mlx",
  name: "Rapid-MLX Provider",
  description: "Local Apple Silicon chat and memory embeddings through Rapid-MLX",
  register(api) {
    api.registerEmbeddingProvider(rapidMlxEmbeddingProvider);
    api.registerProvider({
      ...rapidMlxProvider,
      auth: [
        {
          id: "local",
          label: "Rapid-MLX",
          hint: "Connect to a Rapid-MLX server on Apple Silicon",
          kind: "custom",
          appGuidedSetup: {
            detectAvailability: setup((mod) => mod.detectRapidMlxAvailability),
            detect: setup((mod) => mod.detectRapidMlx),
            prepare: setup((mod) => mod.prepareRapidMlx),
          },
          run: setup((mod) => mod.configureRapidMlxInteractive),
          validateNonInteractive: setup((mod) => mod.validateRapidMlxNonInteractive),
          runNonInteractive: setup((mod) => mod.configureRapidMlxNonInteractive),
        },
      ],
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey === RAPID_MLX_LOCAL_API_KEY,
      wizard: {
        setup: {
          choiceId: "rapid-mlx",
          choiceLabel: "Rapid-MLX",
          choiceHint: "Local Apple Silicon server",
          groupId: "rapid-mlx",
          groupLabel: "Rapid-MLX",
          groupHint: "Local chat and memory embeddings",
          methodId: "local",
        },
        modelPicker: {
          label: "Rapid-MLX",
          hint: "Discover models from the Rapid-MLX server",
          methodId: "local",
        },
      },
    });
  },
});
