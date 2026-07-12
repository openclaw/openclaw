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

function readNodeCommandParams(paramsJSON: string | null | undefined): unknown {
  if (!paramsJSON) {
    return {};
  }
  try {
    return JSON.parse(paramsJSON);
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
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
      const params = readNodeCommandParams(paramsJSON);
      const { handleFileFetch } = await import("./src/node-host/file-fetch.js");
      const result = await handleFileFetch(params as Parameters<typeof handleFileFetch>[0]);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.list",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams(paramsJSON);
      const { handleDirList } = await import("./src/node-host/dir-list.js");
      const result = await handleDirList(params as Parameters<typeof handleDirList>[0]);
      return JSON.stringify(result);
    },
  },
  {
    command: "dir.fetch",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams(paramsJSON);
      const { handleDirFetch } = await import("./src/node-host/dir-fetch.js");
      const result = await handleDirFetch(params as Parameters<typeof handleDirFetch>[0]);
      return JSON.stringify(result);
    },
  },
  {
    command: "file.write",
    cap: "file",
    dangerous: true,
    handle: async (paramsJSON) => {
      const params = readNodeCommandParams(paramsJSON);
      const { handleFileWrite } = await import("./src/node-host/file-write.js");
      const result = await handleFileWrite(params as Parameters<typeof handleFileWrite>[0]);
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
