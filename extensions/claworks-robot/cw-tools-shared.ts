import type { ClaworksRuntime } from "@claworks/runtime";
import { jsonResult, ToolInputError } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { TSchema } from "typebox";

export type CwToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (rt: ClaworksRuntime, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

export function requireClaworksRuntime(getRuntime: () => ClaworksRuntime | null): ClaworksRuntime {
  const rt = getRuntime();
  if (!rt) {
    throw new ToolInputError("ClaWorks runtime is not started");
  }
  return rt;
}

export function registerCwTool(
  api: OpenClawPluginApi,
  getRuntime: () => ClaworksRuntime | null,
  def: CwToolDef,
): void {
  api.registerTool(
    () => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      async execute(_id, rawParams) {
        const rt = requireClaworksRuntime(getRuntime);
        const params = (rawParams ?? {}) as Record<string, unknown>;
        return jsonResult(await def.execute(rt, params));
      },
    }),
    { name: def.name },
  );
}
