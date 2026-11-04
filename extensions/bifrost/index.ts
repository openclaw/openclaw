import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import bifrostProvider from "./provider-catalog.js";

const setup = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("./setup.js")));

export default definePluginEntry({
  id: "bifrost",
  name: "Bifrost Provider",
  description: "Connect to a Bifrost OpenAI-compatible gateway",
  register(api) {
    api.registerProvider({
      ...bifrostProvider,
      auth: [
        {
          id: "api-key",
          label: "Bifrost",
          hint: "Gateway with an optional virtual key",
          kind: "custom",
          run: setup((mod) => mod.configureBifrostInteractive),
          runNonInteractive: setup((mod) => mod.configureBifrostNonInteractive),
        },
      ],
      wizard: {
        setup: {
          choiceId: "bifrost-api-key",
          choiceLabel: "Bifrost",
          groupId: "bifrost",
          groupLabel: "Bifrost",
          groupHint: "OpenAI-compatible model gateway",
          methodId: "api-key",
        },
      },
    });
  },
});
