import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuBoardSchema, type FeishuBoardParams } from "./board-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

async function createWhiteboard(client: Lark.Client, params: FeishuBoardParams) {
  // The Lark SDK doesn't expose whiteboard.create; use raw HTTP request.
  const data: Record<string, unknown> = {};
  if (params.title) {
    data.title = params.title;
  }
  if (params.folder_token) {
    data.folder_token = params.folder_token;
  }

  const res = await (client as any).request({
    method: "POST",
    url: "/open-apis/board/v1/whiteboards",
    data,
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: res.data?.whiteboard?.id,
    title: res.data?.whiteboard?.title,
    url: res.data?.whiteboard?.url,
  };
}

async function createNode(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for create_node");
  }
  if (!params.nodes || params.nodes.length === 0) {
    throw new Error("nodes array is required for create_node");
  }

  const res = await (client as any).board.v1.whiteboardNode.create({
    data: { nodes: params.nodes },
    params: { user_id_type: "open_id" },
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    nodes: res.data?.nodes ?? [],
  };
}

async function createPlantuml(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for create_plantuml");
  }
  if (!params.plant_uml_code) {
    throw new Error("plant_uml_code is required for create_plantuml");
  }

  const data: Record<string, unknown> = {
    plant_uml_code: params.plant_uml_code,
  };
  if (params.style_type !== undefined) {
    data.style_type = params.style_type;
  }
  if (params.syntax_type !== undefined) {
    data.syntax_type = params.syntax_type;
  }
  if (params.diagram_type !== undefined) {
    data.diagram_type = params.diagram_type;
  }

  const res = await (client as any).board.v1.whiteboardNode.createPlantuml({
    data,
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    nodes: res.data?.nodes ?? [],
  };
}

async function listNodes(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for list_nodes");
  }
  const res = await (client as any).board.v1.whiteboardNode.list({
    params: { user_id_type: "open_id" },
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    nodes: res.data?.nodes ?? [],
  };
}

async function getTheme(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for get_theme");
  }
  const res = await (client as any).board.v1.whiteboard.theme({
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    theme: res.data?.theme,
  };
}

async function updateTheme(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for update_theme");
  }
  if (!params.theme) {
    throw new Error("theme is required for update_theme");
  }

  const res = await (client as any).board.v1.whiteboard.updateTheme({
    data: { theme: params.theme },
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    theme: params.theme,
    updated: true,
  };
}

async function downloadImage(client: Lark.Client, params: FeishuBoardParams) {
  if (!params.whiteboard_id) {
    throw new Error("whiteboard_id is required for download_image");
  }
  const res = await (client as any).board.v1.whiteboard.downloadAsImage({
    path: { whiteboard_id: params.whiteboard_id },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    whiteboard_id: params.whiteboard_id,
    downloaded: true,
  };
}

export function registerFeishuBoardTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_board: No config available, skipping board tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_board: No Feishu accounts configured, skipping board tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.board) {
    api.logger.debug?.("feishu_board: board tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_board",
      label: "Feishu Board",
      description:
        "Feishu whiteboard/board operations. Actions: create_whiteboard (create a new whiteboard), create_node (create nodes in a whiteboard), create_plantuml (create PlantUML diagrams including mind maps, flowcharts, sequence diagrams), list_nodes (list all nodes), get_theme, update_theme, download_image",
      parameters: FeishuBoardSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBoardParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "create_whiteboard":
              return json(await createWhiteboard(client, p));
            case "create_node":
              return json(await createNode(client, p));
            case "create_plantuml":
              return json(await createPlantuml(client, p));
            case "list_nodes":
              return json(await listNodes(client, p));
            case "get_theme":
              return json(await getTheme(client, p));
            case "update_theme":
              return json(await updateTheme(client, p));
            case "download_image":
              return json(await downloadImage(client, p));
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    { name: "feishu_board" },
  );

  api.logger.info?.("feishu_board: Registered feishu_board tool");
}
