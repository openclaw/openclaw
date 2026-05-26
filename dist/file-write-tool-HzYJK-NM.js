import { t as callGatewayTool } from "./gateway-CdR1r1Su.js";
import { c as readMediaBuffer } from "./store-b792nN7l.js";
import { i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-DT1n7Zjn.js";
import "./media-store-BznKinrD.js";
import "./agent-harness-runtime-Cs9KBB7L.js";
import { d as FILE_WRITE_TOOL_DESCRIPTOR, f as appendFileTransferAudit, l as FILE_TRANSFER_SUBDIR, u as FILE_WRITE_HARD_MAX_BYTES } from "./descriptors-BOooEAcx.js";
import { a as readTrimmedString, i as readGatewayCallOptions, n as readBoolean, o as throwFromNodePayload, t as humanSize } from "./params-D9sRqOSX.js";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/tools/file-write-tool.ts
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
		buffer: Buffer.from(input.contentBase64, "base64"),
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
