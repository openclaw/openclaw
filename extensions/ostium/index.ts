import { createOstiumTool } from "./src/ostium-tool.ts";

export default function register(api: any) {
  api.registerTool(createOstiumTool(api), { optional: true });
}
