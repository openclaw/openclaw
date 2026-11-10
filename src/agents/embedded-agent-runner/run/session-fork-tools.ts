import type { Context, Tool } from "../../../llm/types.js";

/** Schema-only tool definitions a fork replays; executors never leave the attempt. */
export function projectSessionForkTools(
  tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters"> & { async?: boolean }>,
): NonNullable<Context["tools"]> {
  return tools.map(({ name, description, parameters, async }) => ({
    name,
    description,
    parameters,
    ...(async === false ? { async } : {}),
  }));
}
