import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { researchToolDefinition } from "./src/contract.js";

const load = createLazyRuntimeModule(() => import("./src/tool.js"));
export default definePluginEntry({
  id: "deep-research",
  name: "Deep Research",
  description: "Bounded, evidence-backed research",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          ...researchToolDefinition,
          execute: async (id, params, signal, onUpdate) =>
            (await load()).createResearchTool(api, context).execute(id, params, signal, (message) =>
              onUpdate?.({
                content: [{ type: "text", text: message }],
                details: { progress: message },
              }),
            ),
        }),
      },
      { names: ["deep_research"], optional: true, workspaceAccess: false },
    );
  },
});
