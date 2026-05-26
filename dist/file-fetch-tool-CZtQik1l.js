import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-BZvT6hX1.js";
import "./media-store-3-Nw2YTP.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { c as FILE_FETCH_TOOL_DESCRIPTOR, l as FILE_TRANSFER_SUBDIR, o as FILE_FETCH_DEFAULT_MAX_BYTES, s as FILE_FETCH_HARD_MAX_BYTES } from "./descriptors-DuJgViRb.js";
import { r as TEXT_INLINE_MIME_SET, t as IMAGE_MIME_INLINE_SET } from "./mime-CfMm5H5N.js";
import { t as appendFileTransferAudit } from "./audit-BUOi65Ul.js";
import { a as readTrimmedString, i as readGatewayCallOptions, o as throwFromNodePayload, t as humanSize } from "./params-Dxls3_Dh.js";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/tools/file-fetch-tool.ts
function createFileFetchTool() {
	return {
		...FILE_FETCH_TOOL_DESCRIPTOR,
		execute: async (_toolCallId, args) => {
			const params = args;
			const node = readTrimmedString(params, "node");
			const filePath = readTrimmedString(params, "path");
			if (!node) throw new Error("node required");
			if (!filePath) throw new Error("path required");
			const requestedMax = typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) ? Math.floor(params.maxBytes) : FILE_FETCH_DEFAULT_MAX_BYTES;
			const maxBytes = Math.max(1, Math.min(requestedMax, FILE_FETCH_HARD_MAX_BYTES));
			const gatewayOpts = readGatewayCallOptions(params);
			const nodes = await listNodes(gatewayOpts);
			const nodeId = resolveNodeIdFromList(nodes, node, false);
			const nodeDisplayName = nodes.find((n) => n.nodeId === nodeId)?.displayName ?? node;
			const startedAt = Date.now();
			const raw = await callGatewayTool("node.invoke", gatewayOpts, {
				nodeId,
				command: "file.fetch",
				params: {
					path: filePath,
					maxBytes
				},
				idempotencyKey: crypto.randomUUID()
			});
			const payload = raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : null;
			if (!payload) {
				await appendFileTransferAudit({
					op: "file.fetch",
					nodeId,
					nodeDisplayName,
					requestedPath: filePath,
					decision: "error",
					errorMessage: "invalid payload",
					durationMs: Date.now() - startedAt
				});
				throw new Error("invalid file.fetch payload");
			}
			if (payload.ok === false) {
				await appendFileTransferAudit({
					op: "file.fetch",
					nodeId,
					nodeDisplayName,
					requestedPath: filePath,
					canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
					decision: "error",
					errorCode: typeof payload.code === "string" ? payload.code : void 0,
					errorMessage: typeof payload.message === "string" ? payload.message : void 0,
					durationMs: Date.now() - startedAt
				});
				throwFromNodePayload("file.fetch", payload);
			}
			const canonicalPath = typeof payload.path === "string" ? payload.path : "";
			const size = typeof payload.size === "number" ? payload.size : -1;
			const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
			const hasBase64 = typeof payload.base64 === "string";
			const base64 = hasBase64 ? payload.base64 : "";
			const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
			if (!canonicalPath || size < 0 || !mimeType || !hasBase64 || !sha256) throw new Error("invalid file.fetch payload (missing fields)");
			const buffer = Buffer.from(base64, "base64");
			if (buffer.byteLength !== size) throw new Error(`file.fetch size mismatch: payload says ${size} bytes, decoded ${buffer.byteLength}`);
			if (crypto.createHash("sha256").update(buffer).digest("hex") !== sha256) throw new Error("file.fetch sha256 mismatch (integrity failure)");
			const saved = await saveMediaBuffer(buffer, mimeType, FILE_TRANSFER_SUBDIR, FILE_FETCH_HARD_MAX_BYTES);
			const localPath = saved.path;
			const isInlineImage = IMAGE_MIME_INLINE_SET.has(mimeType);
			const isInlineText = TEXT_INLINE_MIME_SET.has(mimeType) && size <= 8192;
			const content = [];
			if (isInlineImage) content.push({
				type: "image",
				data: base64,
				mimeType
			});
			else if (isInlineText) {
				const text = buffer.toString("utf-8");
				content.push({
					type: "text",
					text: `Fetched ${canonicalPath} (${humanSize(size)}, ${mimeType}, sha256:${sha256.slice(0, 12)}) saved at ${localPath}\n\n--- contents ---\n${text}`
				});
			} else {
				const shortHash = sha256.slice(0, 12);
				content.push({
					type: "text",
					text: `Fetched ${canonicalPath} (${humanSize(size)}, ${mimeType}, sha256:${shortHash}) saved at ${localPath}`
				});
			}
			await appendFileTransferAudit({
				op: "file.fetch",
				nodeId,
				nodeDisplayName,
				requestedPath: filePath,
				canonicalPath,
				decision: "allowed",
				sizeBytes: size,
				sha256,
				durationMs: Date.now() - startedAt
			});
			return {
				content,
				details: {
					path: canonicalPath,
					size,
					mimeType,
					sha256,
					localPath,
					mediaId: saved.id,
					media: { mediaUrls: [localPath] }
				}
			};
		}
	};
}
//#endregion
export { createFileFetchTool };
