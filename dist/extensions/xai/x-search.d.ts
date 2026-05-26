import { t as XaiToolAuthContext } from "../../tool-auth-shared-Bmx32iMq.js";

//#region extensions/xai/x-search.d.ts
declare function createXSearchTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
}): {
  label: string;
  name: string;
  description: string;
  parameters: import("typebox").TObject<{
    query: import("typebox").TString;
    allowed_x_handles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    excluded_x_handles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    from_date: import("typebox").TOptional<import("typebox").TString>;
    to_date: import("typebox").TOptional<import("typebox").TString>;
    enable_image_understanding: import("typebox").TOptional<import("typebox").TBoolean>;
    enable_video_understanding: import("typebox").TOptional<import("typebox").TBoolean>;
  }>;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<import("@earendil-works/pi-agent-core").AgentToolResult<unknown>>;
} | null;
//#endregion
export { createXSearchTool };