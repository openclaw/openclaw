import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import { optionalStringEnum } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readBlobBytes } from "./blob-client.js";
import { clampMaxBytes, resolveAzureBlobDefaultContainer } from "./config.js";

const AzureBlobReadToolSchema = Type.Object(
  {
    containerName: Type.Optional(
      Type.String({
        description:
          "Blob container name. If omitted, uses plugins.entries.azure-blob.config.defaultContainer or AZURE_STORAGE_DEFAULT_CONTAINER.",
      }),
    ),
    blobName: Type.String({
      description:
        "Blob path/name within the container (may include virtual folders, e.g. reports/2024/summary.json).",
    }),
    maxBytes: Type.Optional(
      Type.Number({
        description: `Maximum bytes to read (default 4 MiB, hard cap 20 MiB).`,
        minimum: 1,
        maximum: 20 * 1024 * 1024,
      }),
    ),
    outputEncoding: optionalStringEnum(["utf8", "base64"] as const, {
      description: "Return payload as UTF-8 text or base64 (for binary blobs). Default: utf8.",
    }),
  },
  { additionalProperties: false },
);

export function createAzureBlobReadTool(api: OpenClawPluginApi) {
  return {
    name: "azure_blob_read",
    label: "Azure Blob Read",
    description:
      "Download and return the contents of a blob from Azure Blob Storage. Requires connection string or account name/key (see plugin config / env vars). Opt-in tool.",
    parameters: AzureBlobReadToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const blobName = readStringParam(rawParams, "blobName", { required: true });
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

      const maxBytes = clampMaxBytes(readNumberParam(rawParams, "maxBytes", { integer: true }));
      const outputEncoding =
        readStringParam(rawParams, "outputEncoding") === "base64" ? "base64" : "utf8";

      const result = await readBlobBytes({
        cfg: api.config,
        containerName,
        blobName: blobName.trim(),
        maxBytes,
      });

      if (!result.ok) {
        return jsonResult({ ok: false, error: result.message });
      }

      const payload =
        outputEncoding === "base64"
          ? { text: result.data.toString("base64"), encoding: "base64" as const }
          : { text: result.data.toString("utf8"), encoding: "utf8" as const };

      return jsonResult({
        ok: true,
        containerName,
        blobName: blobName.trim(),
        ...payload,
        truncated: result.truncated,
        contentType: result.contentType,
        sizeBytes: result.data.length,
        blobContentLength: result.contentLength,
      });
    },
  };
}
