/**
 * index.ts — OpenClaw extension entry point for ABB robot control plugin
 *
 * Registers the abb_robot MCP tool for controlling actual ABB robots via PC SDK
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createABBRobotTool } from "./src/abb-robot-tool.js";

const plugin = {
  id: "abb-robot-control",
  name: "ABB Robot Control",
  description:
    "Control actual ABB robots via PC SDK. Connect to robot controllers, " +
    "execute RAPID programs, move robots, and manage motion sequences. " +
    "Supports automatic robot identification and multi-robot configurations.",

  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      controllerHost: {
        type: "string",
        description: "Default ABB robot controller IP address or hostname",
      },
      controllerPort: {
        type: "number",
        description: "Default controller port (default: 7000)",
        minimum: 1,
        maximum: 65535,
      },
      defaultRobot: {
        type: "string",
        description: "Default robot configuration ID (e.g. 'abb-crb-15000')",
      },
      autoConnect: {
        type: "boolean",
        description: "Automatically connect to controller on startup",
      },
      rapidProgramPath: {
        type: "string",
        description: "Path on controller to store generated RAPID programs",
      },
      defaultMode: {
        type: "string",
        description: "Default operation mode: virtual, real, or auto",
        enum: ["virtual", "real", "auto"],
      },
      wsBridgePort: {
        type: "number",
        description: "WebSocket bridge port for virtual mode",
        minimum: 1,
        maximum: 65535,
      },
    },
  },

  register(api: OpenClawPluginApi, config?: Record<string, unknown>) {
    config = config || {};
    const tool = createABBRobotTool(config);
    api.registerTool(tool);

    // Auto-connect if configured
    if (config.autoConnect && config.controllerHost) {
      setTimeout(async () => {
        try {
          await tool.execute("auto-connect", {
            action: "connect",
            mode: config.defaultMode || "real",
            host: config.controllerHost,
            port:
              config.defaultMode === "virtual"
                ? config.wsBridgePort || 9877
                : config.controllerPort || 7000,
            robot_id: config.defaultRobot,
          });
          console.log("[abb-robot-control] Auto-connected to controller");
        } catch (err) {
          console.warn("[abb-robot-control] Auto-connect failed:", err);
        }
      }, 2000);
    }
  },
};

export default plugin;
