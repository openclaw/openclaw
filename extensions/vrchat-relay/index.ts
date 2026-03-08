import { Type } from "@sinclair/typebox";
import {
  authenticate,
  logout,
  isAuthenticated,
  storeSession,
  clearSession,
  getStoredSession,
} from "./src/auth/index.js";
import { getAuditSummary, getRecentLogs } from "./src/tools/audit.js";
import { setAvatarParameter, sendOSCMessage } from "./src/tools/avatar.js";
import {
  setCameraParameter,
  setGreenScreenHSL,
  setLookAtMeComposition,
  setCameraSmoothing,
  captureCamera,
} from "./src/tools/camera.js";
import { sendChatboxMessage } from "./src/tools/chatbox-enhanced.js";
import { setChatboxTyping } from "./src/tools/chatbox.js";
import { discoverAvatarParameters } from "./src/tools/discovery.js";
import { sendInputCommand, VALID_INPUT_ACTIONS } from "./src/tools/input.js";
import {
  startOSCListener,
  stopOSCListener,
  getListenerStatus,
  getRecentMessages,
} from "./src/tools/listener.js";
import {
  setPermissionLevel,
  getPermissionStatus,
  PermissionLevel,
} from "./src/tools/permissions.js";
import { rateLimiters } from "./src/tools/rate-limiter.js";

const plugin = {
  id: "vrchat-relay",
  name: "VRChat Relay",
  description:
    "VRChat integration with OSC protocol for avatar control, chatbox messaging, and input commands",
  version: "2026.2.2",

  configSchema: Type.Object({
    osc: Type.Optional(
      Type.Object({
        outgoingPort: Type.Optional(Type.Number({ default: 9000 })),
        incomingPort: Type.Optional(Type.Number({ default: 9001 })),
        host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      }),
    ),
    security: Type.Optional(
      Type.Object({
        allowInputCommands: Type.Optional(Type.Boolean({ default: false })),
        defaultPermissionLevel: Type.Optional(Type.String({ default: "SAFE" })),
      }),
    ),
  }),

  register(api: { registerTool: (tool: unknown) => void }) {
    console.log("[vrchat-relay] Registering VRChat Relay plugin (Pro Edition)...");

    // vrchat_login - Authenticate with VRChat
    api.registerTool({
      name: "vrchat_login",
      description: "Authenticate with VRChat account (supports 2FA/TOTP)",
      parameters: Type.Object({
        username: Type.String({ description: "VRChat username" }),
        password: Type.String({ description: "VRChat password" }),
        otpCode: Type.Optional(Type.String({ description: "2FA/TOTP code (if 2FA is enabled)" })),
      }),
      async execute(_id: string, params: { username: string; password: string; otpCode?: string }) {
        const result = await authenticate({
          username: params.username,
          password: params.password,
          otpCode: params.otpCode,
        });

        if (result.ok) {
          storeSession(result.value);
          return {
            content: [
              {
                type: "text",
                text: `Successfully logged in as ${result.value.displayName} (${result.value.userId})`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Login failed: ${result.error.message}` }],
          };
        }
      },
    });

    // vrchat_logout - Logout from VRChat
    api.registerTool({
      name: "vrchat_logout",
      description: "Logout from VRChat and clear session",
      parameters: Type.Object({}),
      async execute() {
        const session = getStoredSession();
        if (session) {
          await logout(session.authToken);
        }
        clearSession();
        return {
          content: [{ type: "text", text: "Logged out from VRChat" }],
        };
      },
    });

    // vrchat_status - Check VRChat authentication status
    api.registerTool({
      name: "vrchat_status",
      description: "Check VRChat authentication and OSC connection status",
      parameters: Type.Object({}),
      execute() {
        const authStatus = isAuthenticated();
        const listenerStatus = getListenerStatus();
        const permissionStatus = getPermissionStatus();

        return {
          content: [
            {
              type: "text",
              text: `VRChat Status:
- Authenticated: ${authStatus ? "Yes" : "No"}
- OSC Listener: ${listenerStatus.isRunning ? "Running" : "Stopped"}
- Messages Received: ${listenerStatus.messageCount}
- Permission Level: ${permissionStatus.currentLevel}
- Level Description: ${permissionStatus.description}`,
            },
          ],
        };
      },
    });

    // vrchat_permission_set - Set permission level
    api.registerTool({
      name: "vrchat_permission_set",
      description:
        "Set permission level (SAFE/PRO/DIRECTOR). Higher levels require explicit user confirmation.",
      parameters: Type.Object({
        level: Type.String({ description: "Permission level: SAFE, PRO, or DIRECTOR" }),
      }),
      execute(_id: string, params: { level: string }) {
        const result = setPermissionLevel(params.level as PermissionLevel);

        return {
          content: [
            {
              type: "text",
              text: result.success ? result.message : `Failed: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      },
    });

    // vrchat_permission_status - Get permission status
    api.registerTool({
      name: "vrchat_permission_status",
      description: "Get current permission level and allowed operations",
      parameters: Type.Object({}),
      execute() {
        const status = getPermissionStatus();

        return {
          content: [
            {
              type: "text",
              text: `Permission Status:
- Current Level: ${status.currentLevel}
- Description: ${status.description}
- Active Since: ${status.since.toISOString()}
- Allowed Operations:
${status.allowedOperations.map((op) => `  - ${op}`).join("\n")}`,
            },
          ],
        };
      },
    });

    // vrchat_chatbox - Send message to chatbox
    api.registerTool({
      name: "vrchat_chatbox",
      description:
        "Send a message to VRChat chatbox with typing animation (max 144 characters, 9 lines)",
      parameters: Type.Object({
        message: Type.String({ description: "Message to send (max 144 characters)" }),
        sendImmediately: Type.Optional(
          Type.Boolean({
            description: "Send immediately or wait for user confirmation",
            default: true,
          }),
        ),
        sfx: Type.Optional(Type.Boolean({ description: "Play notification sound", default: true })),
        typingDelayMs: Type.Optional(
          Type.Number({ description: "Typing animation delay in ms", default: 1200 }),
        ),
      }),
      async execute(
        _id: string,
        params: {
          message: string;
          sendImmediately?: boolean;
          sfx?: boolean;
          typingDelayMs?: number;
        },
      ) {
        const result = await sendChatboxMessage({
          message: params.message,
          sendImmediately: params.sendImmediately,
          sfx: params.sfx,
          typingDelayMs: params.typingDelayMs,
        });

        if (result.success) {
          const trimmedMsg = result.trimmed ? " (message was trimmed to fit limits)" : "";
          return {
            content: [
              {
                type: "text",
                text: `Message sent to VRChat chatbox${trimmedMsg}: "${params.message.substring(0, 50)}${params.message.length > 50 ? "..." : ""}"`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to send: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_typing - Set typing indicator
    api.registerTool({
      name: "vrchat_typing",
      description: "Set typing indicator in VRChat chatbox",
      parameters: Type.Object({
        typing: Type.Boolean({ description: "Whether user is typing" }),
      }),
      execute(_id: string, params: { typing: boolean }) {
        const result = setChatboxTyping({ typing: params.typing });

        if (result.success) {
          return {
            content: [{ type: "text", text: `Typing indicator set to: ${params.typing}` }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set typing: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_set_avatar_param - Set avatar parameter
    api.registerTool({
      name: "vrchat_set_avatar_param",
      description: "Set an avatar parameter (bool, int, or float)",
      parameters: Type.Object({
        name: Type.String({ description: "Parameter name (as defined in avatar)" }),
        value: Type.Union([Type.Boolean(), Type.Number()], { description: "Parameter value" }),
      }),
      execute(_id: string, params: { name: string; value: boolean | number }) {
        const result = setAvatarParameter({
          name: params.name,
          value: params.value,
        });

        if (result.success) {
          return {
            content: [
              { type: "text", text: `Avatar parameter "${params.name}" set to ${params.value}` },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set parameter: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_discover - Discover avatar parameters
    api.registerTool({
      name: "vrchat_discover",
      description:
        "Discover available OSC parameters for current avatar using OSCQuery and local JSON",
      parameters: Type.Object({
        avatarId: Type.String({ description: "Avatar ID (from /avatar/change event)" }),
      }),
      async execute(_id: string, params: { avatarId: string }) {
        const result = await discoverAvatarParameters(params.avatarId);

        const paramList =
          result.parameters.length > 0
            ? result.parameters.map((p) => `  - ${p.name} (${p.type})`).join("\n")
            : "  No parameters discovered";

        return {
          content: [
            {
              type: "text",
              text: `Discovery Result:
- Avatar ID: ${result.avatarId}
- Source: ${result.source}
- Parameters Found: ${result.parameters.length}
- Timestamp: ${result.timestamp.toISOString()}

Parameters:
${paramList}`,
            },
          ],
        };
      },
    });

    // vrchat_send_osc - Send raw OSC message
    api.registerTool({
      name: "vrchat_send_osc",
      description: "Send a raw OSC message to VRChat",
      parameters: Type.Object({
        address: Type.String({ description: "OSC address (e.g., /avatar/parameters/Example)" }),
        args: Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), {
          description: "OSC arguments",
        }),
      }),
      execute(
        _id: string,
        params: { address: string; args: (string | number | boolean | null)[] },
      ) {
        const result = sendOSCMessage({
          address: params.address,
          args: params.args,
        });

        if (result.success) {
          return {
            content: [{ type: "text", text: `OSC message sent to ${params.address}` }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to send OSC: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_input - Send input command (PRO guard required)
    api.registerTool({
      name: "vrchat_input",
      description:
        "Send input command to VRChat (Jump, Move, Look, Voice). Requires PRO permission.",
      guard: "PRO",
      parameters: Type.Object({
        action: Type.String({
          description: `Input action to perform. Valid values: ${VALID_INPUT_ACTIONS.join(", ")}`,
        }),
        value: Type.Optional(
          Type.Union([Type.Boolean(), Type.Number()], {
            description: "Action value (default: true)",
          }),
        ),
      }),
      execute(_id: string, params: { action: string; value?: boolean | number }) {
        const result = sendInputCommand({
          action: params.action,
          value: params.value,
        });

        if (result.success) {
          return {
            content: [{ type: "text", text: `Input command "${params.action}" sent` }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to send input: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_camera_set - Set camera parameter (DIRECTOR permission)
    api.registerTool({
      name: "vrchat_camera_set",
      description:
        "Set VRChat camera parameter (Zoom, Aperture, FocalDistance, etc.). Requires DIRECTOR permission.",
      guard: "DIRECTOR",
      parameters: Type.Object({
        parameter: Type.String({
          description:
            "Camera parameter name (e.g., Zoom, Aperture, FocalDistance, Exposure, FlySpeed, TurnSpeed)",
        }),
        value: Type.Union([Type.Number(), Type.Boolean()], { description: "Parameter value" }),
      }),
      execute(_id: string, params: { parameter: string; value: number | boolean }) {
        const result = setCameraParameter({
          parameter: params.parameter,
          value: params.value,
        });

        if (result.success) {
          const clampedMsg = result.clamped ? " (value was clamped to valid range)" : "";
          return {
            content: [
              {
                type: "text",
                text: `Camera parameter "${params.parameter}" set to ${params.value}${clampedMsg}`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set camera: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_camera_greenscreen - Set GreenScreen HSL
    api.registerTool({
      name: "vrchat_camera_greenscreen",
      description: "Set GreenScreen HSL values for chroma key. Requires DIRECTOR permission.",
      guard: "DIRECTOR",
      parameters: Type.Object({
        hue: Type.Optional(Type.Number({ description: "Hue (0-360)" })),
        saturation: Type.Optional(Type.Number({ description: "Saturation (0-100)" })),
        lightness: Type.Optional(Type.Number({ description: "Lightness (0-50)" })),
      }),
      execute(_id: string, params: { hue?: number; saturation?: number; lightness?: number }) {
        const result = setGreenScreenHSL({
          hue: params.hue,
          saturation: params.saturation,
          lightness: params.lightness,
        });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `GreenScreen HSL set: H=${params.hue}, S=${params.saturation}, L=${params.lightness}`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set greenscreen: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_camera_lookatme - Set LookAtMe composition
    api.registerTool({
      name: "vrchat_camera_lookatme",
      description: "Set LookAtMe with X/Y offsets. Requires DIRECTOR permission.",
      guard: "DIRECTOR",
      parameters: Type.Object({
        enabled: Type.Optional(Type.Boolean({ description: "Enable LookAtMe" })),
        xOffset: Type.Optional(Type.Number({ description: "X offset (-25 to 25)" })),
        yOffset: Type.Optional(Type.Number({ description: "Y offset (-25 to 25)" })),
      }),
      execute(_id: string, params: { enabled?: boolean; xOffset?: number; yOffset?: number }) {
        const result = setLookAtMeComposition({
          enabled: params.enabled,
          xOffset: params.xOffset,
          yOffset: params.yOffset,
        });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `LookAtMe composition set: enabled=${params.enabled}, X=${params.xOffset}, Y=${params.yOffset}`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set LookAtMe: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_camera_capture - Trigger camera capture
    api.registerTool({
      name: "vrchat_camera_capture",
      description: "Trigger VRChat camera capture. Requires DIRECTOR permission.",
      guard: "DIRECTOR",
      parameters: Type.Object({
        delayed: Type.Optional(
          Type.Boolean({ description: "Use delayed capture (uses timer)", default: false }),
        ),
      }),
      execute(_id: string, params: { delayed?: boolean }) {
        const result = captureCamera(params.delayed);

        if (result.success) {
          const mode = params.delayed ? "delayed" : "immediate";
          return {
            content: [{ type: "text", text: `Camera capture triggered (${mode})` }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to capture: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_start_listener - Start OSC listener
    api.registerTool({
      name: "vrchat_start_listener",
      description: "Start OSC listener to receive messages from VRChat",
      parameters: Type.Object({}),
      execute() {
        const result = startOSCListener();

        if (result.success) {
          return {
            content: [{ type: "text", text: `OSC listener started on port ${result.port}` }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to start listener: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_stop_listener - Stop OSC listener
    api.registerTool({
      name: "vrchat_stop_listener",
      description: "Stop OSC listener",
      parameters: Type.Object({}),
      execute() {
        const result = stopOSCListener();

        if (result.success) {
          return {
            content: [{ type: "text", text: "OSC listener stopped" }],
          };
        } else {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to stop listener: ${result.error}` }],
          };
        }
      },
    });

    // vrchat_listener_status - Get listener status
    api.registerTool({
      name: "vrchat_listener_status",
      description: "Get OSC listener status and recent messages",
      parameters: Type.Object({
        messageCount: Type.Optional(
          Type.Number({ description: "Number of recent messages to show", default: 10 }),
        ),
      }),
      execute(_id: string, params: { messageCount?: number }) {
        const status = getListenerStatus();
        const messages = getRecentMessages(params.messageCount || 10);

        let messageText = "No recent messages";
        if (messages.length > 0) {
          messageText = messages.map((m) => `${m.address}: ${JSON.stringify(m.args)}`).join("\n");
        }

        return {
          content: [
            {
              type: "text",
              text: `OSC Listener Status:
- Running: ${status.isRunning}
- Port: ${status.port}
- Messages Received: ${status.messageCount}
- Start Time: ${status.startTime || "N/A"}

Recent Messages:
${messageText}`,
            },
          ],
        };
      },
    });

    // vrchat_audit_logs - Get audit logs
    api.registerTool({
      name: "vrchat_audit_logs",
      description: "Get recent audit logs for debugging and monitoring",
      parameters: Type.Object({
        count: Type.Optional(Type.Number({ description: "Number of recent logs", default: 20 })),
      }),
      execute(_id: string, params: { count?: number }) {
        const logs = getRecentLogs(params.count || 20);
        const summary = getAuditSummary();

        const logText = logs
          .map((log) => `[${log.timestamp}] ${log.level}: ${log.operation}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Audit Log Summary:
- Total Operations: ${summary.total}
- INFO: ${summary.byLevel.INFO}
- SKIP: ${summary.byLevel.SKIP}
- ERROR: ${summary.byLevel.ERROR}
- WARN: ${summary.byLevel.WARN}

Recent Logs:
${logText}`,
            },
          ],
        };
      },
    });

    // vrchat_reset_rate_limits - Reset rate limiters
    api.registerTool({
      name: "vrchat_reset_rate_limits",
      description: "Reset all rate limiters (for testing/debugging)",
      parameters: Type.Object({}),
      execute() {
        Object.values(rateLimiters).forEach((limiter) => limiter.reset());
        return {
          content: [{ type: "text", text: "All rate limiters have been reset" }],
        };
      },
    });

    console.log("[vrchat-relay] VRChat Relay Pro plugin registered successfully");
    console.log(
      "[vrchat-relay] Features: Camera Control, Permission Profiles, Rate Limiting, OSCQuery Discovery",
    );
  },
};

export default plugin;
