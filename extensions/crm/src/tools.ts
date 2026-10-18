import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  crmCompleteActivityTool,
  crmLogActivityTool,
  crmMyTasksTool,
  crmTimelineTool,
} from "./activity-tools.js";
import {
  crmCreateRecordTool,
  crmGetRecordTool,
  crmListRecordsTool,
  crmSearchTool,
  crmUpdateRecordTool,
} from "./record-tools.js";

export function createCrmTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    crmSearchTool(api),
    crmListRecordsTool(api),
    crmGetRecordTool(api),
    crmCreateRecordTool(api),
    crmUpdateRecordTool(api),
    crmLogActivityTool(api),
    crmTimelineTool(api),
    crmMyTasksTool(api),
    crmCompleteActivityTool(api),
  ];
}
