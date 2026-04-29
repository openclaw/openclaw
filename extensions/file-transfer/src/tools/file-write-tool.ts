import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { gatekeep } from "../shared/gatekeep.js";
import {
  humanSize,
  readBoolean,
  readGatewayCallOptions,
  readTrimmedString,
} from "../shared/params.js";
import { evaluateFilePolicy } from "../shared/policy.js";

const FILE_WRITE_SCHEMA = Type.Object({
  node: Type.String({ description: "Node id or display name to write the file on." }),
  path: Type.String({
    description: "Absolute path on the node to write. Canonicalized server-side.",
  }),
  contentBase64: Type.String({
    description: "Base64-encoded bytes to write. Maximum 16 MB after decode.",
  }),
  mimeType: Type.Optional(
    Type.String({
      description: "Content type hint. Not validated against the content.",
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description: "Allow overwriting an existing file. Default false.",
      default: false,
    }),
  ),
  createParents: Type.Optional(
    Type.Boolean({
      description: "Create missing parent directories (mkdir -p). Default false.",
      default: false,
    }),
  ),
});

type FileWriteSuccess = {
  ok: true;
  path: string;
  size: number;
  sha256: string;
  overwritten: boolean;
};

type FileWriteError = {
  ok: false;
  code: string;
  message: string;
  canonicalPath?: string;
};

type FileWritePayload = FileWriteSuccess | FileWriteError;

export function createFileWriteTool(): AnyAgentTool {
  return {
    label: "File Write",
    name: "file_write",
    description:
      "Write file bytes to a paired node by absolute path. Atomic write (temp + rename). Refuses to overwrite by default — pass overwrite=true to replace. Refuses to write through symlink targets (the node will reject if the path resolves to a symlink). Pair with file_fetch to round-trip a file from one node to another: file_fetch returns base64 in the image content block (.data) and as inline content for small text — pass that base64 directly as contentBase64 here. DO NOT use exec/cp/system.run for file copies; this tool IS the same-machine copy. Requires operator opt-in: gateway.nodes.allowCommands must include 'file.write' AND gateway.nodes.fileTransfer.<node>.allowWritePaths must match the destination path. Without policy configured, every call is denied.",
    parameters: FILE_WRITE_SCHEMA,
    async execute(_toolCallId, params) {
      const raw: Record<string, unknown> =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      const nodeQuery = readTrimmedString(raw, "node");
      const filePath = readTrimmedString(raw, "path");
      // Type-check, NOT truthy-check: empty string is the valid base64
      // representation of a zero-byte file, and rejecting "" here would
      // make zero-byte writes impossible round-trip from file_fetch.
      const contentBase64Raw = raw.contentBase64;
      if (typeof contentBase64Raw !== "string") {
        throw new Error("contentBase64 required (string, may be empty for zero-byte files)");
      }
      const contentBase64 = contentBase64Raw;
      const overwrite = readBoolean(raw, "overwrite", false);
      const createParents = readBoolean(raw, "createParents", false);

      if (!nodeQuery) {
        throw new Error("node required");
      }
      if (!filePath) {
        throw new Error("path required");
      }

      // Compute the sha256 of the bytes we're sending so the node can do
      // an end-to-end integrity check after writing. This is always
      // sender-side computed; ignore any caller-supplied expectedSha256
      // to avoid the model passing a wrong hash and triggering an
      // unintended unlink.
      const buffer = Buffer.from(contentBase64, "base64");
      const expectedSha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      const gatewayOpts = readGatewayCallOptions(raw);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, nodeQuery, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? nodeQuery;
      const startedAt = Date.now();

      const gate = await gatekeep({
        op: "file.write",
        nodeId,
        nodeDisplayName,
        kind: "write",
        path: filePath,
        toolCallId: _toolCallId,
        gatewayOpts,
        startedAt,
        promptVerb: "Write file",
      });
      if (!gate.ok) {
        throw new Error(gate.throwMessage);
      }

      const result = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "file.write",
        params: {
          path: filePath,
          contentBase64,
          overwrite,
          createParents,
          expectedSha256,
          followSymlinks: gate.followSymlinks,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload = (result as { payload?: unknown })?.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        await appendFileTransferAudit({
          op: "file.write",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          decision: "error",
          errorMessage: "unexpected response from node",
          sizeBytes: buffer.byteLength,
          durationMs: Date.now() - startedAt,
        });
        throw new Error("unexpected file.write response from node");
      }

      const typed = payload as FileWritePayload;
      if (!typed.ok) {
        await appendFileTransferAudit({
          op: "file.write",
          nodeId,
          nodeDisplayName,
          requestedPath: filePath,
          canonicalPath: typed.canonicalPath,
          decision: "error",
          errorCode: typed.code,
          errorMessage: typed.message,
          sizeBytes: buffer.byteLength,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("file.write", typed as unknown as Record<string, unknown>);
      }

      // Post-flight policy on canonicalized path.
      if (typed.path !== filePath) {
        const postflight = evaluateFilePolicy({
          nodeId,
          nodeDisplayName,
          kind: "write",
          path: typed.path,
        });
        if (!postflight.ok) {
          await appendFileTransferAudit({
            op: "file.write",
            nodeId,
            nodeDisplayName,
            requestedPath: filePath,
            canonicalPath: typed.path,
            decision: "denied:symlink_escape",
            errorCode: postflight.code,
            reason: postflight.reason,
            sizeBytes: typed.size,
            sha256: typed.sha256,
            durationMs: Date.now() - startedAt,
          });
          // The file is already written. The most we can do here is
          // surface the issue loudly. We don't try to unlink because
          // (a) the file may legitimately exist there and we just
          // didn't have policy for it, and (b) unlinking on policy
          // failure adds destructive ambiguity.
          throw new Error(
            `file.write SYMLINK_TARGET_WARNING: file written but canonical path ${typed.path} is not in this node's allowWritePaths`,
          );
        }
      }

      await appendFileTransferAudit({
        op: "file.write",
        nodeId,
        nodeDisplayName,
        requestedPath: filePath,
        canonicalPath: typed.path,
        decision: "allowed",
        sizeBytes: typed.size,
        sha256: typed.sha256,
        durationMs: Date.now() - startedAt,
      });

      const overwriteNote = typed.overwritten ? " (overwrote existing file)" : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${typed.path} (${humanSize(typed.size)}, sha256:${typed.sha256.slice(0, 12)})${overwriteNote}`,
          },
        ],
        details: typed,
      };
    },
  };
}
