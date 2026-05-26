import { t as XaiToolAuthContext } from "../../tool-auth-shared-DVABFHEn.js";
import { Type } from "typebox";
import * as _$_earendil_works_pi_agent_core0 from "@earendil-works/pi-agent-core";

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
  execute: (_toolCallId: string, args: Record<string, unknown>) => Promise<_$_earendil_works_pi_agent_core0.AgentToolResult<unknown>>;
} | null;
//#endregion
export { createCodeExecutionTool };