import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import {
  createAzureBlobListBlobsTool,
  createAzureBlobListContainersTool,
} from "./src/blob-list-tools.js";
import { createAzureBlobReadTool } from "./src/blob-read-tool.js";

export default definePluginEntry({
  id: "azure-blob",
  name: "Azure Blob Storage",
  description:
    "List containers, list blobs, and read blob contents from Azure Storage (azure_blob_list_containers, azure_blob_list_blobs, azure_blob_read).",
  register(api) {
    api.registerTool(createAzureBlobReadTool(api) as AnyAgentTool, { optional: true });
    api.registerTool(createAzureBlobListContainersTool(api) as AnyAgentTool, { optional: true });
    api.registerTool(createAzureBlobListBlobsTool(api) as AnyAgentTool, { optional: true });
  },
});
