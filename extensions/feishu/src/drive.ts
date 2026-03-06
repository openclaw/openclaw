import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import {
  FeishuDriveSchema,
  type FeishuDriveParams,
  type FeishuDriveAction,
} from "./drive-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============ Actions ============

async function getRootFolderToken(client: Lark.Client): Promise<string> {
  // Use generic HTTP client to call the root folder meta API
  // as it's not directly exposed in the SDK
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK property
  const domain = (client as any).domain ?? "https://open.feishu.cn";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK property
  const res = (await (client as any).httpInstance.get(
    `${domain}/open-apis/drive/explorer/v2/root_folder/meta`,
  )) as { code: number; msg?: string; data?: { token?: string } };
  if (res.code !== 0) {
    throw new Error(res.msg ?? "Failed to get root folder");
  }
  const token = res.data?.token;
  if (!token) {
    throw new Error("Root folder token not found");
  }
  return token;
}

async function listFolder(client: Lark.Client, folderToken?: string) {
  // Filter out invalid folder_token values (empty, "0", etc.)
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : undefined;
  const res = await client.drive.file.list({
    params: validFolderToken ? { folder_token: validFolderToken } : {},
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    files:
      res.data?.files?.map((f) => ({
        token: f.token,
        name: f.name,
        type: f.type,
        url: f.url,
        created_time: f.created_time,
        modified_time: f.modified_time,
        owner_id: f.owner_id,
      })) ?? [],
    next_page_token: res.data?.next_page_token,
  };
}

async function getFileInfo(client: Lark.Client, fileToken: string, folderToken?: string) {
  // Use list with folder_token to find file info
  const res = await client.drive.file.list({
    params: folderToken ? { folder_token: folderToken } : {},
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
    owner_id: file.owner_id,
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken?: string) {
  // Feishu supports using folder_token="0" as the root folder.
  // We *try* to resolve the real root token (explorer API), but fall back to "0"
  // because some tenants/apps return 400 for that explorer endpoint.
  let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
  if (effectiveToken === "0") {
    try {
      effectiveToken = await getRootFolderToken(client);
    } catch {
      // ignore and keep "0"
    }
  }

  const res = await client.drive.file.createFolder({
    data: {
      name,
      folder_token: effectiveToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    token: res.data?.token,
    url: res.data?.url,
  };
}

async function moveFile(client: Lark.Client, fileToken: string, type: string, folderToken: string) {
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides",
      folder_token: folderToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function deleteFile(client: Lark.Client, fileToken: string, type: string) {
  const res = await client.drive.file.delete({
    path: { file_token: fileToken },
    params: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides"
        | "shortcut",
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function uploadFile(
  client: Lark.Client,
  fileName: string,
  content: string,
  parentNode: string,
) {
  const buf = Buffer.from(content, "utf-8");
  const res = await client.drive.file.uploadAll({
    data: {
      file_name: fileName,
      parent_type: "explorer",
      parent_node: parentNode,
      size: buf.length,
      file: buf,
    },
  });
  if (!res?.file_token) {
    throw new Error("Upload failed: no file_token returned");
  }
  return { file_token: res.file_token };
}

const IMPORT_POLL_INTERVAL_MS = 2000;
const IMPORT_MAX_POLLS = 15;

async function importFile(
  client: Lark.Client,
  fileToken: string,
  fileExtension: string,
  targetType: string,
  mountKey: string,
  fileName?: string,
) {
  // Only include file_name if defined — undefined fields can cause schema mismatch
  const data: {
    file_extension: string;
    file_token: string;
    type: string;
    file_name?: string;
    point: { mount_type: number; mount_key: string };
  } = {
    file_extension: fileExtension,
    file_token: fileToken,
    type: targetType,
    point: { mount_type: 1, mount_key: mountKey },
  };
  if (fileName) {
    data.file_name = fileName;
  }

  const createRes = await client.drive.importTask.create({ data });
  if (createRes.code !== 0) {
    throw new Error(createRes.msg ?? "Failed to create import task");
  }

  const ticket = createRes.data?.ticket;
  if (!ticket) {
    throw new Error("No import task ticket returned");
  }

  for (let i = 0; i < IMPORT_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, IMPORT_POLL_INTERVAL_MS));
    const getRes = await client.drive.importTask.get({ path: { ticket } });
    const result = getRes.data?.result;
    if (result?.job_status === 0) {
      return { token: result.token, url: result.url, type: result.type };
    }
    if (result?.job_status === 2) {
      throw new Error(result.job_error_msg || "Import failed");
    }
  }
  throw new Error("Import timeout after 30s");
}

// ============ Tool Registration ============

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
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

  type FeishuDriveExecuteParams = FeishuDriveParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_drive",
        label: "Feishu Drive",
        description:
          "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete, upload (upload text content as file), import (convert uploaded file to Feishu doc/sheet)",
        parameters: FeishuDriveSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDriveExecuteParams & { action: FeishuDriveAction };
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "list":
                return json(await listFolder(client, p.folder_token));
              case "info":
                return json(await getFileInfo(client, p.file_token!));
              case "create_folder":
                return json(await createFolder(client, p.name!, p.folder_token));
              case "move":
                return json(await moveFile(client, p.file_token!, p.type!, p.folder_token!));
              case "delete":
                return json(await deleteFile(client, p.file_token!, p.type!));
              case "upload":
                return json(await uploadFile(client, p.file_name!, p.content!, p.folder_token!));
              case "import":
                return json(
                  await importFile(
                    client,
                    p.file_token!,
                    p.file_extension!,
                    p.target_type!,
                    p.folder_token!,
                    p.file_name,
                  ),
                );
              default:
                return json({ error: `Unknown action: ${p.action}` });
            }
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_drive" },
  );

  api.logger.info?.(`feishu_drive: Registered feishu_drive tool`);
}
