import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { SSHSessionManager } from "./session-manager.js";

let sessionManager: SSHSessionManager | null = null;

function getSessionManager(api: OpenClawPluginApi): SSHSessionManager {
  if (!sessionManager) {
    const config = api.pluginConfig || {};
    sessionManager = new SSHSessionManager({
      maxSessions: config.maxSessions as number | undefined,
      sessionTimeoutMs: config.sessionTimeoutMs as number | undefined,
      commandTimeoutMs: config.commandTimeoutMs as number | undefined,
    });
  }
  return sessionManager;
}

export function createOpenSSHSessionTool(api: OpenClawPluginApi) {
  return {
    name: "open_ssh_session",
    label: "Open SSH Session",
    description:
      "Opens a persistent SSH connection to a remote server. Returns a session_id that must be used for all subsequent commands. The session maintains its state (working directory, environment variables) across multiple commands. IMPORTANT: Remember the session_id - you will need it for execute_ssh_command and close_ssh_session. AUTHENTICATION: If no password or privateKey is provided, the tool will automatically search for SSH keys in ~/.ssh/ (id_ed25519, id_rsa, etc.), just like a normal SSH client.",
    parameters: Type.Object({
      host: Type.String({
        description: "The hostname or IP address of the SSH server",
      }),
      port: Type.Optional(
        Type.Number({
          description: "The SSH port (default: 22)",
        }),
      ),
      username: Type.String({
        description: "The username for SSH authentication",
      }),
      password: Type.Optional(
        Type.String({
          description:
            "Optional: The password for SSH authentication. If not provided, will try to use SSH keys from ~/.ssh/",
        }),
      ),
      privateKey: Type.Optional(
        Type.String({
          description:
            "Optional: The private key for SSH authentication in PEM/OpenSSH format. If not provided, will automatically search for keys in ~/.ssh/ (bot_key, id_ed25519, id_rsa, etc.)",
        }),
      ),
      passphrase: Type.Optional(
        Type.String({
          description: "The passphrase for the private key, if encrypted",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const manager = getSessionManager(api);

      try {
        const config = {
          host: params.host as string,
          port: params.port as number | undefined,
          username: params.username as string,
          password: params.password as string | undefined,
          privateKey: params.privateKey as string | undefined,
          passphrase: params.passphrase as string | undefined,
        };

        // Note: If no password or privateKey is provided, the session manager
        // will automatically search for default SSH keys in ~/.ssh/
        const sessionId = await manager.openSession(config);

        const message = `SSH session opened successfully.

Session ID: ${sessionId}
Host: ${config.host}
Username: ${config.username}

IMPORTANT: Save this session_id! You must use it in execute_ssh_command and close_ssh_session calls.

Example usage:
1. Execute commands: execute_ssh_command(session_id="${sessionId}", command="pwd")
2. When done: close_ssh_session(session_id="${sessionId}")`;

        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            session_id: sessionId,
            host: config.host,
            username: config.username,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [{ type: "text" as const, text: `Failed to open SSH session: ${errorMessage}` }],
          isError: true,
          details: {},
        };
      }
    },
  };
}

export function createExecuteSSHCommandTool(api: OpenClawPluginApi) {
  return {
    name: "execute_ssh_command",
    label: "Execute SSH Command",
    description:
      "Executes a command in an existing SSH session. The session maintains its state, so directory changes (cd) and environment variables persist across commands. The command output is returned when the shell prompt reappears.",
    parameters: Type.Object({
      session_id: Type.String({
        description: "The session ID returned by open_ssh_session",
      }),
      command: Type.String({
        description: "The command to execute in the SSH session",
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "Optional: The timeout for this command in milliseconds. Overrides the default command timeout.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const manager = getSessionManager(api);

      try {
        const sessionId = params.session_id as string;
        const command = params.command as string;
        const timeoutMs = params.timeout_ms as number | undefined;

        if (!sessionId) {
          throw new Error("session_id is required");
        }

        if (!command) {
          throw new Error("command is required");
        }

        const output = await manager.executeCommand(sessionId, command, timeoutMs);

        return {
          content: [{ type: "text" as const, text: output || "(command executed, no output)" }],
          details: {
            session_id: sessionId,
            command,
            output,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to execute command: ${errorMessage}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
  };
}

export function createCloseSSHSessionTool(api: OpenClawPluginApi) {
  return {
    name: "close_ssh_session",
    label: "Close SSH Session",
    description:
      "Closes an SSH session and frees up resources. IMPORTANT: Always call this when you are done with a session to prevent resource leaks. Sessions will also be automatically closed after a period of inactivity.",
    parameters: Type.Object({
      session_id: Type.String({
        description: "The session ID returned by open_ssh_session",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const manager = getSessionManager(api);

      try {
        const sessionId = params.session_id as string;

        if (!sessionId) {
          throw new Error("session_id is required");
        }

        await manager.closeSession(sessionId);

        return {
          content: [
            {
              type: "text" as const,
              text: `SSH session ${sessionId} closed successfully.`,
            },
          ],
          details: {
            session_id: sessionId,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to close session: ${errorMessage}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
  };
}

export function createListSSHSessionsTool(api: OpenClawPluginApi) {
  return {
    name: "list_ssh_sessions",
    label: "List SSH Sessions",
    description:
      "Lists all currently open SSH sessions with their IDs, hosts, and last activity times. Useful for tracking which sessions are active.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>) {
      const manager = getSessionManager(api);

      try {
        const sessions = manager.listSessions();

        if (sessions.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active SSH sessions." }],
            details: { sessions: [] },
          };
        }

        const sessionList = sessions
          .map((s) => {
            const lastActivityAgo = Math.floor((Date.now() - s.lastActivity) / 1000);
            return `- Session ID: ${s.id}\n  Host: ${s.host}\n  Username: ${s.username}\n  Last activity: ${lastActivityAgo}s ago`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Active SSH Sessions (${sessions.length}):\n\n${sessionList}`,
            },
          ],
          details: { sessions },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list sessions: ${errorMessage}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
  };
}

export async function cleanupSSHSessions() {
  if (sessionManager) {
    await sessionManager.cleanup();
    sessionManager = null;
  }
}
