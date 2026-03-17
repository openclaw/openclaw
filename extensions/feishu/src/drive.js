import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuDriveSchema } from "./drive-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult
} from "./tool-result.js";
async function getRootFolderToken(client) {
  const domain = client.domain ?? "https://open.feishu.cn";
  const res = await client.httpInstance.get(
    `${domain}/open-apis/drive/explorer/v2/root_folder/meta`
  );
  if (res.code !== 0) {
    throw new Error(res.msg ?? "Failed to get root folder");
  }
  const token = res.data?.token;
  if (!token) {
    throw new Error("Root folder token not found");
  }
  return token;
}
async function listFolder(client, folderToken) {
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : void 0;
  const res = await client.drive.file.list({
    params: validFolderToken ? { folder_token: validFolderToken } : {}
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    files: res.data?.files?.map((f) => ({
      token: f.token,
      name: f.name,
      type: f.type,
      url: f.url,
      created_time: f.created_time,
      modified_time: f.modified_time,
      owner_id: f.owner_id
    })) ?? [],
    next_page_token: res.data?.next_page_token
  };
}
async function getFileInfo(client, fileToken, folderToken) {
  const res = await client.drive.file.list({
    params: folderToken ? { folder_token: folderToken } : {}
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const file = res.data?.files?.find((f) => f.token === fileToken);
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }
  return {
    token: file.token,
    name: file.name,
    type: file.type,
    url: file.url,
    created_time: file.created_time,
    modified_time: file.modified_time,
    owner_id: file.owner_id
  };
}
async function createFolder(client, name, folderToken) {
  let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
  if (effectiveToken === "0") {
    try {
      effectiveToken = await getRootFolderToken(client);
    } catch {
    }
  }
  const res = await client.drive.file.createFolder({
    data: {
      name,
      folder_token: effectiveToken
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    token: res.data?.token,
    url: res.data?.url
  };
}
async function moveFile(client, fileToken, type, folderToken) {
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type,
      folder_token: folderToken
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    success: true,
    task_id: res.data?.task_id
  };
}
async function deleteFile(client, fileToken, type) {
  const res = await client.drive.file.delete({
    path: { file_token: fileToken },
    params: {
      type
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    success: true,
    task_id: res.data?.task_id
  };
}
function registerFeishuDriveTools(api) {
  if (!api.config) {
    api.logger.debug?.("feishu_drive: No config available, skipping drive tools");
    return;
  }
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_drive: No Feishu accounts configured, skipping drive tools");
    return;
  }
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.drive) {
    api.logger.debug?.("feishu_drive: drive tool disabled in config");
    return;
  }
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_drive",
        label: "Feishu Drive",
        description: "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete",
        parameters: FeishuDriveSchema,
        async execute(_toolCallId, params) {
          const p = params;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId
            });
            switch (p.action) {
              case "list":
                return jsonToolResult(await listFolder(client, p.folder_token));
              case "info":
                return jsonToolResult(await getFileInfo(client, p.file_token));
              case "create_folder":
                return jsonToolResult(await createFolder(client, p.name, p.folder_token));
              case "move":
                return jsonToolResult(await moveFile(client, p.file_token, p.type, p.folder_token));
              case "delete":
                return jsonToolResult(await deleteFile(client, p.file_token, p.type));
              default:
                return unknownToolActionResult(p.action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        }
      };
    },
    { name: "feishu_drive" }
  );
  api.logger.info?.(`feishu_drive: Registered feishu_drive tool`);
}
export {
  registerFeishuDriveTools
};
