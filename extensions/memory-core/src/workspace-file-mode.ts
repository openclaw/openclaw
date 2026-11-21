import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
export type WorkspaceFileMode = AgentDefaults["workspaceFileMode"];
