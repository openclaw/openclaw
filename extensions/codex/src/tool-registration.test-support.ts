import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

/** Exercise the registered V2 contract, not a separately constructed tool. */
export function registeredCodexTools(
  register: { mock: { calls: Parameters<OpenClawPluginApi["registerTool"]>[] } },
  name?: string,
) {
  const registration = register.mock.calls.find(([, options]) =>
    name ? options?.name === name : Array.isArray(options?.names),
  );
  const factory = registration?.[0];
  if (
    !factory ||
    typeof factory === "function" ||
    !("contextVersion" in factory) ||
    factory.contextVersion !== 2
  ) {
    throw new Error("Expected a version 2 Codex tool registration");
  }
  return {
    factory,
    options: registration?.[1],
    create(context: OpenClawPluginToolContext = {}) {
      const tools = factory.create({
        ...context,
        assertInvocationCurrent: context.assertInvocationCurrent ?? (() => {}),
      });
      return Array.isArray(tools) ? tools : tools ? [tools] : [];
    },
  };
}
