import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  DEFAULT_LIST_MAX_RESULTS,
  HARD_MAX_LIST_RESULTS,
  listBlobContainers,
  listBlobsInContainer,
} from "./blob-client.js";
import { resolveAzureBlobDefaultContainer } from "./config.js";

const ListContainersSchema = Type.Object(
  {
    prefix: Type.Optional(
      Type.String({
        description: "Optional filter: only container names that start with this prefix.",
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({
        description: `Maximum containers to return (default ${DEFAULT_LIST_MAX_RESULTS}, hard cap ${HARD_MAX_LIST_RESULTS}).`,
        minimum: 1,
        maximum: HARD_MAX_LIST_RESULTS,
      }),
    ),
  },
  { additionalProperties: false },
);

const ListBlobsSchema = Type.Object(
  {
    containerName: Type.Optional(
      Type.String({
        description:
          "Blob container name. If omitted, uses plugins.entries.azure-blob.config.defaultContainer or AZURE_STORAGE_DEFAULT_CONTAINER.",
      }),
    ),
    prefix: Type.Optional(
      Type.String({
        description:
          "Optional blob name prefix (virtual folder), e.g. reports/2024/ — only blobs whose names start with this value.",
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({
        description: `Maximum blobs to return (default ${DEFAULT_LIST_MAX_RESULTS}, hard cap ${HARD_MAX_LIST_RESULTS}).`,
        minimum: 1,
        maximum: HARD_MAX_LIST_RESULTS,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createAzureBlobListContainersTool(api: OpenClawPluginApi) {
  return {
    name: "azure_blob_list_containers",
    label: "Azure Blob List Containers",
    description:
      "List blob containers in the configured Azure Storage account (names only; paginated). Requires connection string or account name/key. Opt-in tool.",
    parameters: ListContainersSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const prefix = readStringParam(rawParams, "prefix");
      const maxResults = readNumberParam(rawParams, "maxResults", { integer: true });

      const result = await listBlobContainers({
        cfg: api.config,
        prefix: prefix?.trim() || undefined,
        maxResults: maxResults ?? undefined,
      });

      if (!result.ok) {
        return jsonResult({ ok: false, error: result.message });
      }

      return jsonResult({
        ok: true,
        containers: result.containers,
        count: result.containers.length,
        truncated: result.truncated,
      });
    },
  };
}

export function createAzureBlobListBlobsTool(api: OpenClawPluginApi) {
  return {
    name: "azure_blob_list_blobs",
    label: "Azure Blob List Blobs",
    description:
      "List blobs in an Azure Storage container (name, size, content type when available). Optional name prefix for virtual folders. Opt-in tool.",
    parameters: ListBlobsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const containerArg = readStringParam(rawParams, "containerName");
      const defaultContainer = resolveAzureBlobDefaultContainer(api.config);
      const containerName = (containerArg ?? defaultContainer ?? "").trim();
      if (!containerName) {
        return jsonResult({
          ok: false,
          error:
            "containerName is required unless defaultContainer is set in plugins.entries.azure-blob.config or AZURE_STORAGE_DEFAULT_CONTAINER.",
        });
      }

      const prefix = readStringParam(rawParams, "prefix");
      const maxResults = readNumberParam(rawParams, "maxResults", { integer: true });

      const result = await listBlobsInContainer({
        cfg: api.config,
        containerName,
        prefix: prefix?.trim() || undefined,
        maxResults: maxResults ?? undefined,
      });

      if (!result.ok) {
        return jsonResult({ ok: false, error: result.message });
      }

      return jsonResult({
        ok: true,
        containerName: result.containerName,
        blobs: result.blobs,
        count: result.blobs.length,
        truncated: result.truncated,
      });
    },
  };
}
