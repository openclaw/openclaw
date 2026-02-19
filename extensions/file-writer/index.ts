import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createFileWriterTool } from "./src/file-writer-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createFileWriterTool(api) as unknown as AnyAgentTool, { optional: true });
}
