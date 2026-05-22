import { t as XaiToolAuthContext } from "../../tool-auth-shared-D3Z0N6py.js";
import * as _$typebox from "typebox";
import * as _$_mariozechner_pi_agent_core0 from "@mariozechner/pi-agent-core";

//#region extensions/xai/x-search.d.ts
declare function createXSearchTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
}): {
  label: string;
  name: string;
  description: string;
  parameters: _$typebox.TObject<{
    query: _$typebox.TString;
    allowed_x_handles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    excluded_x_handles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    from_date: _$typebox.TOptional<_$typebox.TString>;
    to_date: _$typebox.TOptional<_$typebox.TString>;
    enable_image_understanding: _$typebox.TOptional<_$typebox.TBoolean>;
    enable_video_understanding: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<_$_mariozechner_pi_agent_core0.AgentToolResult<unknown>>;
} | null;
//#endregion
export { createXSearchTool };