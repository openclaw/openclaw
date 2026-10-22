import type { SkillEntry, SkillSnapshot } from "../../skills/types.js";
import type { CoreToolDeclaration } from "../agent-tool-metadata.js";
import { createOpenClawCodingToolsInternalAsync } from "../agent-tools.js";
import type { InternalCodingToolsOptions } from "../agent-tools.options.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { prepareHostSkillLibraryResources } from "./host-skills.js";
import { cloneHostSnapshot } from "./host-snapshot.js";

type SurfaceOptions = Parameters<
  NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
>[0];

/** Async construction and its literal data share the exact admitted host lifetime. */
export function bindHostToolDeclarations(params: {
  assertActive: () => void;
  signal: AbortSignal;
  skillResourceSnapshot: (options: SurfaceOptions) => SkillSnapshot | undefined;
  toolConstructionInputs: (
    options: SurfaceOptions,
    entries: readonly SkillEntry[],
    assertCurrent?: () => void,
  ) => {
    options: InternalCodingToolsOptions;
    skillReadResources: SkillSnapshot["resolvedSkills"];
  };
  withToolConstructionScope: <T>(run: () => T) => T;
  bindCreatedTools: (
    tools: AnyAgentTool[],
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => AnyAgentTool[];
}) {
  const { assertActive } = params;
  const surfaces = new WeakMap<readonly AnyAgentTool[], readonly CoreToolDeclaration[]>();
  return {
    createToolSurfaceAsync: async (
      options: SurfaceOptions,
      bindingOptions?: Readonly<{ cwd?: string }>,
    ) => {
      assertActive();
      let declarations: CoreToolDeclaration[] = [];
      const selections = params.skillResourceSnapshot(options)?.librarySelections ?? [];
      const library = selections.length
        ? await prepareHostSkillLibraryResources(selections, assertActive)
        : undefined;
      const inputs = params.toolConstructionInputs(
        options,
        library?.entries ?? [],
        library?.assertCurrent,
      );
      const sourceTools = await params.withToolConstructionScope(() =>
        createOpenClawCodingToolsInternalAsync(
          inputs.options,
          inputs.skillReadResources,
          undefined,
          undefined,
          { assertCurrent: library?.assertCurrent ?? assertActive, signal: params.signal },
          (value) => {
            declarations = value;
          },
        ),
      );
      assertActive();
      const tools = params.bindCreatedTools(sourceTools, bindingOptions);
      surfaces.set(tools, declarations);
      return tools;
    },
    readCoreToolDeclarations: (tools: readonly AnyAgentTool[]) => {
      assertActive();
      const declarations = surfaces.get(tools);
      if (!declarations) {
        throw new Error("Core declarations require this host's exact async tool surface");
      }
      return cloneHostSnapshot(declarations);
    },
  };
}
