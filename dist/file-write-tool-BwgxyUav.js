import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { c as readMediaBuffer } from "./store-rQFzzX5P.js";
import { i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-BZvT6hX1.js";
import "./media-store-3-Nw2YTP.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { d as FILE_WRITE_TOOL_DESCRIPTOR, l as FILE_TRANSFER_SUBDIR, u as FILE_WRITE_HARD_MAX_BYTES } from "./descriptors-DuJgViRb.js";
import { t as appendFileTransferAudit } from "./audit-BUOi65Ul.js";
import { a as readTrimmedString, i as readGatewayCallOptions, n as readBoolean, o as throwFromNodePayload, t as humanSize } from "./params-Dxls3_Dh.js";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/tools/file-write-tool.ts
function normalizeBase64ForCompare(value) {
	return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}
function decodeStrictBase64(value) {
	const buffer = Buffer.from(value, "base64");
	if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) throw new Error("contentBase64 is not valid base64");
	return buffer;
}
async function readSourceBytes(input) {
	const sourceMediaId = input.sourceMediaId?.trim();
	if (sourceMediaId) {
		const { buffer } = await readMediaBuffer(sourceMediaId, FILE_TRANSFER_SUBDIR, FILE_WRITE_HARD_MAX_BYTES);
		return {
			buffer,
			contentBase64: buffer.toString("base64"),
			source: "media"
		};
	}
	if (input.contentBase64 === void 0) throw new Error("contentBase64 or sourceMediaId required");
	return {
		buffer: decodeStrictBase64(input.contentBase64),
		contentBase64: input.contentBase64,
		source: "inline"
	};
}
function createFileWriteTool() {
	return {
		...FILE_WRITE_TOOL_DESCRIPTOR,
		async execute(_toolCallId, params) {
			const raw = params && typeof params === "object" && !Array.isArray(params) ? params : {};
			const nodeQuery = readTrimmedString(raw, "node");
			const filePath = readTrimmedString(raw, "path");
			const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : void 0;
			const sourceMediaId = typeof raw.sourceMediaId === "string" ? raw.sourceMediaId : void 0;
			const overwrite = readBoolean(raw, "overwrite", false);
			const createParents = readBoolean(raw, "createParents", false);
			if (!nodeQuery) throw new Error("node required");
			if (!filePath) throw new Error("path required");
			const sourceBytes = await readSourceBytes({
				contentBase64,
				sourceMediaId
			});
			const buffer = sourceBytes.buffer;
			const expectedSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
			const gatewayOpts = readGatewayCallOptions(raw);
			const nodes = await listNodes(gatewayOpts);
			const nodeId = resolveNodeIdFromList(nodes, nodeQuery, false);
			const nodeDisplayName = nodes.find((n) => n.nodeId === nodeId)?.displayName ?? nodeQuery;
			const startedAt = Date.now();
			const payload = (await callGatewayTool("node.invoke", gatewayOpts, {
				nodeId,
				command: "file.write",
				params: {
					path: filePath,
					contentBase64: sourceBytes.contentBase64,
					overwrite,
					createParents,
					expectedSha256
				},
				idempotencyKey: crypto.randomUUID()
			}))?.payload;
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				await appendFileTransferAudit({
					op: "file.write",
					nodeId,
					nodeDisplayName,
					requestedPath: filePath,
					decision: "error",
					errorMessage: "unexpected response from node",
					sizeBytes: buffer.byteLength,
					durationMs: Date.now() - startedAt
				});
				throw new Error("unexpected file.write response from node");
			}
			const typed = payload;
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
					durationMs: Date.now() - startedAt
				});
				throwFromNodePayload("file.write", typed);
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
				durationMs: Date.now() - startedAt
			});
			const overwriteNote = typed.overwritten ? " (overwrote existing file)" : "";
			return {
				content: [{
					type: "text",
					text: `Wrote ${typed.path} (${humanSize(typed.size)}, sha256:${typed.sha256.slice(0, 12)})${overwriteNote}`
				}],
				details: {
					...typed,
					source: sourceBytes.source
				}
			};
		}
	};
}
//#endregion
export { createFileWriteTool };
