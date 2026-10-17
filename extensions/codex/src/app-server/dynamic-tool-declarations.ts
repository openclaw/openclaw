import { applyEmbeddedAttemptToolsAllow } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import type { CodexToolDescriptor } from "./dynamic-tool-catalog.js";
import { filterCodexDynamicTools } from "./dynamic-tool-profile.js";

/** Fresh host-owned core declarations plus truthful plugin/runtime definitions. */
export async function buildDynamicToolDeclarations(
  input: Parameters<typeof buildDynamicTools>[0],
): Promise<CodexToolDescriptor[]> {
  let core: readonly CodexToolDescriptor[] = [];
  const tools = await buildDynamicTools(input, (surface, runtimeToolAllowlist) => {
    const read = input.params.hostCapabilities.readCoreToolDeclarations;
    if (!read) {
      throw new Error("Codex declarations require a current host core declaration capability");
    }
    core = applyEmbeddedAttemptToolsAllow([...read(surface)], runtimeToolAllowlist);
  });
  input.params.hostCapabilities.assertActive();
  // Shell topology is selected by the executable builder. Reuse that selection
  // and placement rather than reproducing native/sandbox/host policy here.
  const dynamicShell = tools.filter((tool) => tool.name === "exec" || tool.name === "process");
  core = [
    ...filterCodexDynamicTools([...core], input.pluginConfig).filter(
      (tool) => tool.name !== "exec" && tool.name !== "process",
    ),
    ...dynamicShell.flatMap((tool) => {
      const declaration = core.find((entry) => entry.name === tool.name);
      return declaration ? [{ ...declaration, catalogMode: tool.catalogMode }] : [];
    }),
  ];
  const coreNames = new Set(core.map((declaration) => declaration.name));
  // The host only projects concrete core producers, never a plugin collision.
  return [...tools.filter((tool) => !coreNames.has(tool.name)), ...core].map(
    ({ name, description, parameters, catalogMode }) => {
      const data: CodexToolDescriptor = { name, description, parameters };
      if (catalogMode) {
        data.catalogMode = catalogMode;
      }
      return data;
    },
  );
}
