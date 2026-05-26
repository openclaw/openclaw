import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-BZvT6hX1.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { a as DIR_LIST_TOOL_DESCRIPTOR, i as DIR_LIST_HARD_MAX_ENTRIES } from "./descriptors-DuJgViRb.js";
import { t as appendFileTransferAudit } from "./audit-BUOi65Ul.js";
import { a as readTrimmedString, i as readGatewayCallOptions, o as throwFromNodePayload, r as readClampedInt } from "./params-Dxls3_Dh.js";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/tools/dir-list-tool.ts
function createDirListTool() {
	return {
		...DIR_LIST_TOOL_DESCRIPTOR,
		execute: async (_toolCallId, args) => {
			const params = args;
			const node = readTrimmedString(params, "node");
			const dirPath = readTrimmedString(params, "path");
			if (!node) throw new Error("node required");
			if (!dirPath) throw new Error("path required");
			const maxEntries = readClampedInt({
				input: params,
				key: "maxEntries",
				defaultValue: 200,
				hardMin: 1,
				hardMax: DIR_LIST_HARD_MAX_ENTRIES
			});
			const pageToken = typeof params.pageToken === "string" && params.pageToken.trim() ? params.pageToken.trim() : void 0;
			const gatewayOpts = readGatewayCallOptions(params);
			const nodes = await listNodes(gatewayOpts);
			const nodeId = resolveNodeIdFromList(nodes, node, false);
			const nodeDisplayName = nodes.find((n) => n.nodeId === nodeId)?.displayName ?? node;
			const startedAt = Date.now();
			const raw = await callGatewayTool("node.invoke", gatewayOpts, {
				nodeId,
				command: "dir.list",
				params: {
					path: dirPath,
					pageToken,
					maxEntries
				},
				idempotencyKey: crypto.randomUUID()
			});
			const payload = raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : null;
			if (!payload) {
				await appendFileTransferAudit({
					op: "dir.list",
					nodeId,
					nodeDisplayName,
					requestedPath: dirPath,
					decision: "error",
					errorMessage: "invalid payload",
					durationMs: Date.now() - startedAt
				});
				throw new Error("invalid dir.list payload");
			}
			if (payload.ok === false) {
				await appendFileTransferAudit({
					op: "dir.list",
					nodeId,
					nodeDisplayName,
					requestedPath: dirPath,
					canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
					decision: "error",
					errorCode: typeof payload.code === "string" ? payload.code : void 0,
					errorMessage: typeof payload.message === "string" ? payload.message : void 0,
					durationMs: Date.now() - startedAt
				});
				throwFromNodePayload("dir.list", payload);
			}
			const canonicalPath = typeof payload.path === "string" ? payload.path : dirPath;
			const entries = Array.isArray(payload.entries) ? payload.entries : [];
			const truncated = payload.truncated === true;
			const nextPageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : void 0;
			const fileCount = entries.filter((e) => !e.isDir).length;
			const dirCount = entries.filter((e) => e.isDir).length;
			const summary = `Listed ${canonicalPath}: ${fileCount} file${fileCount !== 1 ? "s" : ""}, ${dirCount} subdir${dirCount !== 1 ? "s" : ""}${truncated ? " (more entries available — pass nextPageToken)" : ""}`;
			await appendFileTransferAudit({
				op: "dir.list",
				nodeId,
				nodeDisplayName,
				requestedPath: dirPath,
				canonicalPath,
				decision: "allowed",
				durationMs: Date.now() - startedAt
			});
			return {
				content: [{
					type: "text",
					text: summary
				}],
				details: {
					path: canonicalPath,
					entries,
					nextPageToken,
					truncated
				}
			};
		}
	};
}
//#endregion
export { createDirListTool };
