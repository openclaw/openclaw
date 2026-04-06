import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
}));

vi.mock("../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => undefined,
  getActiveRuntimeWebToolsMetadata: () => undefined,
}));

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: () => stubTool("agents_list"),
}));
vi.mock("./tools/canvas-tool.js", () => ({
  createCanvasTool: () => stubTool("canvas"),
}));
vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: () => stubTool("cron"),
}));
vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: () => stubTool("gateway"),
}));
vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => stubTool("image_generate"),
}));
vi.mock("./tools/image-tool.js", () => ({
  createImageTool: () => stubTool("image"),
}));
vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: () => stubTool("message"),
}));
vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () => stubTool("nodes"),
}));
vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: () => stubTool("pdf"),
}));
vi.mock("./tools/plan-mode-tools.js", () => ({
  createEnterPlanModeTool: () => stubTool("enter_plan_mode"),
  createExitPlanModeTool: () => stubTool("exit_plan_mode"),
  createTodoWriteTool: () => stubTool("todo_write"),
  createTaskCreateTool: () => stubTool("task_create"),
  createTaskUpdateTool: () => stubTool("task_update"),
}));
vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: () => stubTool("session_status"),
}));
vi.mock("./tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => stubTool("sessions_history"),
}));
vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: () => stubTool("sessions_list"),
}));
vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => stubTool("sessions_send"),
}));
vi.mock("./tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => stubTool("sessions_spawn"),
}));
vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => stubTool("sessions_yield"),
}));
vi.mock("./tools/subagents-tool.js", () => ({
  createSubagentsTool: () => stubTool("subagents"),
}));
vi.mock("./tools/tts-tool.js", () => ({
  createTtsTool: () => stubTool("tts"),
}));
vi.mock("./tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => stubTool("update_plan"),
}));
vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: () => stubTool("video_generate"),
}));
vi.mock("./tools/web-tools.js", () => ({
  createWebSearchTool: () => null,
  createWebFetchTool: () => null,
}));

import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw-tools plan mode registration", () => {
  it("registers the plan mode tools in the shipped core tool list", () => {
    const names = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      config: {} as OpenClawConfig,
      disablePluginTools: true,
    }).map((tool) => tool.name);

    expect(names).toContain("enter_plan_mode");
    expect(names).toContain("exit_plan_mode");
    expect(names).toContain("todo_write");
    expect(names).toContain("task_create");
    expect(names).toContain("task_update");
  });
});
