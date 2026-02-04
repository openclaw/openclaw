import type { AgentTool } from "@mariozechner/pi-agent-core";

<<<<<<< HEAD
// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
=======
// oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
export type AnyAgentTool = AgentTool<any, unknown>;
