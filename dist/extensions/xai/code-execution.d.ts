import { t as XaiToolAuthContext } from "../../tool-auth-shared-Bmx32iMq.js";
import { Type } from "typebox";

//#region extensions/xai/code-execution.d.ts
declare function createCodeExecutionTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
}): {
  label: string;
  name: string;
  description: string;
  parameters: Type.TObject<{
    task: Type.TString;
  }>;
  execute: (_toolCallId: string, args: Record<string, unknown>) => Promise<import("@earendil-works/pi-agent-core").AgentToolResult<unknown>>;
} | null;
//#endregion
export { createCodeExecutionTool };