export {
  canvasConfigSchema,
  isCanvasHostEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
  type CanvasHostConfig,
  type CanvasPluginConfig,
} from "./src/config.js";
export { registerNodesCanvasCommands, type CanvasNodesRpcOpts } from "./src/cli.js";
