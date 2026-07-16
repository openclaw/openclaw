// File Transfer plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { createLazyFileTransferNodeInvokePolicy } from "./src/shared/lazy-node-invoke-policy.js";
import {
  DIR_FETCH_TOOL_DESCRIPTOR,
  DIR_LIST_TOOL_DESCRIPTOR,
  FILE_FETCH_TOOL_DESCRIPTOR,
  FILE_WRITE_TOOL_DESCRIPTOR,
} from "./src/tools/descriptors.js";

type FileTransferToolDescriptor = Pick<
  AnyAgentTool,
  "label" | "name" | "description" | "parameters"
>;

type NodeCommandParamsParseError = {
  ok: false;
  code: "INVALID_PARAMS";
  message: string;
};

function readNodeCommandParams<T>(
  paramsJSON: string | null | undefined,
): T | NodeCommandParamsParseError {
  if (!paramsJSON) {
    return {} as T;
  }
  try {
    return JSON.parse(paramsJSON) as T;
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `node command params must be valid JSON: ${String(err)}`,
    };
  }
}

function isParseError(value: unknown): value is NodeCommandParamsParseError {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false &&
    "code" in value &&
    (value as { code?: unknown }).code === "INVALID_PARAMS" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function createLazyTool(
  descriptor: FileTransferToolDescriptor,
  loadTool: () => Promise<AnyAgentTool>,
): AnyAgentTool {
  let toolPromise: Promise<AnyAgentTool> | undefined;
  const loadOnce = () => {
    toolPromise ??= loadTool();
    return toolPromise;
  };
  return {
    ...descriptor,
    async execute(toolCallId, args, signal, onUpdate) {
      const tool = await loadOnce();
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

const fileTransferNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "file.fetch",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams<Parameters<typeof handleFileFetch>[0]>(paramsJSON);
      if (isParseError(params)) {
        return JSON.stringify(params);
      }
      const { handleFileFetch } = await import("./src/node-host/file-fetch.js");
      const result = await handleFileFetch(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.list",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams<Parameters<typeof handleDirList>[0]>(paramsJSON);
      if (isParseError(params)) {
        return JSON.stringify(params);
      }
      const { handleDirList } = await import("./src/node-host/dir-list.js");
      const result = await handleDirList(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.fetch",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams<Parameters<typeof handleDirFetch>[0]>(paramsJSON);
      if (isParseError(params)) {
        return JSON.stringify(params);
      }
      const { handleDirFetch } = await import("./src/node-host/dir-fetch.js");
      const result = await handleDirFetch(params);
      return JSON.stringify(result);
    },
  },
  {
    command: "file.write",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams<Parameters<typeof handleFileWrite>[0]>(paramsJSON);
      if (isParseError(params)) {
        return JSON.stringify(params);
      }
      const { handleFileWrite } = await import("./src/node-host/file-write.js");
      const result = await handleFileWrite(params);
      return JSON.stringify(result);
    },
  },
];

export default definePluginEntry({
  id: "file-transfer",
  name: "File Transfer",
  description: "Fetch, list, and write files on paired nodes via dedicated node commands.",
  nodeHostCommands: fileTransferNodeHostCommands,
  register(api) {
    api.registerNodeInvokePolicy(createLazyFileTransferNodeInvokePolicy());
    api.registerTool(
      createLazyTool(FILE_FETCH_TOOL_DESCRIPTOR, async () => {
        const { createFileFetchTool } = await import("./src/tools/file-fetch-tool.js");
        return createFileFetchTool();
      }),
    );
    api.registerTool(
      createLazyTool(DIR_LIST_TOOL_DESCRIPTOR, async () => {
        const { createDirListTool } = await import("./src/tools/dir-list-tool.js");
        return createDirListTool();
      }),
    );
    api.registerTool(
      createLazyTool(DIR_FETCH_TOOL_DESCRIPTOR, async () => {
        const { createDirFetchTool } = await import("./src/tools/dir-fetch-tool.js");
        return createDirFetchTool();
      }),
    );
    api.registerTool(
      createLazyTool(FILE_WRITE_TOOL_DESCRIPTOR, async () => {
        const { createFileWriteTool } = await import("./src/tools/file-write-tool.js");
        return createFileWriteTool();
      }),
    );
  },
});
