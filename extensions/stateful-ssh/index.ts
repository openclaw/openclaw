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
        const tools = [
          createOpenSSHSessionTool(api),
          createExecuteSSHCommandTool(api),
          createCloseSSHSessionTool(api),
          createListSSHSessionsTool(api),
        ];

        // Return null if any tool creation failed
        if (tools.some(tool => !tool)) {
          return null;
        }

        return tools;
      },
      { names: ["open_ssh_session", "execute_ssh_command", "close_ssh_session", "list_ssh_sessions"] }
    );

    // Register cleanup handler
    if (api.runtime) {
      process.on("beforeExit", () => {
        cleanupSSHSessions().catch((err) => {
          console.error("Error cleaning up SSH sessions:", err);
        });
      });

      process.on("SIGINT", () => {
        cleanupSSHSessions()
          .catch((err) => {
            console.error("Error cleaning up SSH sessions:", err);
          })
          .finally(() => {
            process.exit(0);
          });
      });

      process.on("SIGTERM", () => {
        cleanupSSHSessions()
          .catch((err) => {
            console.error("Error cleaning up SSH sessions:", err);
          })
          .finally(() => {
            process.exit(0);
          });
      });
    }
  },
};

export default statefulSSHPlugin;
