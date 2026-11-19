export const PLUGIN_DECLARED_SURFACES = [
  { id: "channels", label: "Channels" },
  { id: "providers", label: "Providers" },
  { id: "tools", label: "Tools" },
  { id: "contracts", label: "Contracts" },
  { id: "hooks", label: "Hooks" },
  { id: "mcpServers", label: "MCP servers" },
  { id: "cliCommands", label: "CLI commands" },
  { id: "cliBackends", label: "CLI backends" },
  { id: "skills", label: "Skills" },
  { id: "dangerousConfigFlags", label: "Dangerous configuration flags" },
] as const;

type DeclaredSurfaceGroups<T extends readonly { id: string }[]> = {
  -readonly [Index in keyof T]: T[Index]["id"];
};

export const PLUGIN_DECLARED_SURFACE_GROUPS: Readonly<
  DeclaredSurfaceGroups<typeof PLUGIN_DECLARED_SURFACES>
> =
  // SAFETY: Mapping IDs preserves the exported tuple's exact length and order.
  PLUGIN_DECLARED_SURFACES.map((surface) => surface.id) as DeclaredSurfaceGroups<
    typeof PLUGIN_DECLARED_SURFACES
  >;

export type PluginDeclaredSurfaceGroup = (typeof PLUGIN_DECLARED_SURFACE_GROUPS)[number];
