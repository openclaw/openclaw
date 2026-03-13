/**
 * index.ts — OpenClaw extension entry point for robot-kinematic plugin.
 *
 * Registers the robot_control agent tool with the OpenClaw plugin API.
 * The plugin is self-contained: it reads robot configs from its own
 * robots/ directory and communicates with the viewer via WebSocket.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createRobotControlTool } from "./src/robot-kinematic-tool.js";

const plugin = {
  id: "robot-kinematic",
  name: "Robot Kinematic Viewer",
  description:
    "Control robot arms in the kinematic viewer via natural-language chat. " +
    "Supports joint control, named presets, motion sequences, and multi-robot switching.",

  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      wsHost: {
        type: "string",
        description: "WebSocket bridge host (default: 127.0.0.1)",
      },
      wsPort: {
        type: "number",
        description: "WebSocket bridge port (default: 9877)",
        minimum: 1,
        maximum: 65535,
      },
      defaultRobot: {
        type: "string",
        description: "Default robot ID to load on startup (default: abb-crb-15000)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const tool = createRobotControlTool();
    api.registerTool(tool);
  },
};

export default plugin;

