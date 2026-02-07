import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createCompoundCommandHandler, createBeforeAgentStartHook } from "./src/compound.js";
import { createCompoundPostgresService } from "./src/service.js";

const plugin = {
  id: "compound-postgres",
  name: "Compound PostgreSQL",
  description: "Compound engineering loop with PostgreSQL audit logging",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 1. Service: diagnostic event → PostgreSQL audit_events
    api.registerService(createCompoundPostgresService());

    // 2. Command: /compound — capture session learnings
    api.registerCommand({
      name: "compound",
      description: "Capture a session learning to the compound knowledge base",
      acceptsArgs: true,
      requireAuth: true,
      handler: createCompoundCommandHandler(api.logger),
    });

    // 3. Hook: inject relevant past learnings into new agent sessions
    api.on("before_agent_start", createBeforeAgentStartHook(api.logger));
  },
};

export default plugin;
