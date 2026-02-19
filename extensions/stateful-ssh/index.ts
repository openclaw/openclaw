import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createOpenSSHSessionTool,
  createExecuteSSHCommandTool,
  createCloseSSHSessionTool,
  createListSSHSessionsTool,
  cleanupSSHSessions,
} from "./src/ssh-tools.js";

const statefulSSHPlugin = {
  id: "stateful-ssh",
  name: "Stateful SSH",
  description: "Persistent SSH session management with state preservation.",
  register(api: OpenClawPluginApi) {
    // Register all SSH tools with explicit names
    api.registerTool(
      (ctx) => {
        // Disable SSH tools in sandboxed contexts for security
        if (ctx.sandboxed) {
          return null;
        }

        const tools = [
          createOpenSSHSessionTool(api),
          createExecuteSSHCommandTool(api),
          createCloseSSHSessionTool(api),
          createListSSHSessionsTool(api),
        ];

        // Return null if any tool creation failed
        if (tools.some((tool) => !tool)) {
          return null;
        }

        return tools;
      },
      {
        names: [
          "open_ssh_session",
          "execute_ssh_command",
          "close_ssh_session",
          "list_ssh_sessions",
        ],
      },
    );

    // Register as service for lifecycle management
    api.registerService({
      id: "stateful-ssh-cleanup",
      start: async () => {
        api.logger.debug?.("Stateful SSH service started");
      },
      stop: async () => {
        api.logger.debug?.("Cleaning up SSH sessions...");
        try {
          await cleanupSSHSessions();
        } catch (err) {
          api.logger.error(`Error cleaning up SSH sessions: ${err}`);
        }
      },
    });
  },
};

export default statefulSSHPlugin;
