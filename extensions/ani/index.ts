import { aniPlugin } from "./src/channel.js";
import { setAniRuntime } from "./src/runtime.js";
import { emptyPluginConfigSchema, type OpenClawPluginApi } from "./src/sdk-compat.js";
import {
  createCreateTaskTool,
  createDeleteTaskTool,
  createGetHistoryTool,
  createGetTaskTool,
  createListTasksTool,
  createSendFileTool,
  createUpdateTaskTool,
} from "./src/tools.js";
// Tool names: ani_send_file, ani_fetch_chat_history_messages, ani_list_conversation_tasks, ani_get_task, ani_create_task, ani_update_task, ani_delete_task

const plugin = {
  id: "ani",
  name: "Agent-Native IM",
  description: "ANI Agent-Native IM channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setAniRuntime(api.runtime);
    // Register tool via BOTH paths for maximum compatibility:
    // 1. api.registerTool() — plugin tools path (resolvePluginTools)
    // 2. agentTools on channel — channel tools path (listChannelAgentTools)
    const sendFileTool = createSendFileTool();
    const getHistoryTool = createGetHistoryTool();
    const listTasksTool = createListTasksTool();
    const getTaskTool = createGetTaskTool();
    const createTaskTool = createCreateTaskTool();
    const updateTaskTool = createUpdateTaskTool();
    const deleteTaskTool = createDeleteTaskTool();
    const tools = [
      sendFileTool,
      getHistoryTool,
      listTasksTool,
      getTaskTool,
      createTaskTool,
      updateTaskTool,
      deleteTaskTool,
    ];
    api.registerTool(sendFileTool);
    api.registerTool(getHistoryTool);
    api.registerTool(listTasksTool);
    api.registerTool(getTaskTool);
    api.registerTool(createTaskTool);
    api.registerTool(updateTaskTool);
    api.registerTool(deleteTaskTool);
    api.registerChannel({ plugin: { ...aniPlugin, agentTools: () => tools } });
  },
};

export default plugin;
