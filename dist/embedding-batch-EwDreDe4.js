import { C as withRemoteHttpResponse, T as formatUnavailableBatchError, _ as buildBatchHeaders, b as applyEmbeddingBatchOutputLine, d as uploadBatchJsonlFile, f as resolveBatchCompletionFromStatus, g as runEmbeddingBatchGroups, h as buildEmbeddingBatchGroupOptions, m as throwIfBatchTerminalFailure, p as resolveCompletedBatchResult, v as normalizeBatchBaseUrl, w as extractBatchErrorMessage, x as postJsonWithRetry, y as EMBEDDING_BATCH_ENDPOINT } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
//#region extensions/voyage/embedding-batch.ts
const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 5e4;
function resolveVoyageBatchDeps(overrides) {
	return {
		now: overrides?.now ?? Date.now,
		sleep: overrides?.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
		postJsonWithRetry: overrides?.postJsonWithRetry ?? postJsonWithRetry,
		uploadBatchJsonlFile: overrides?.uploadBatchJsonlFile ?? uploadBatchJsonlFile,
		withRemoteHttpResponse: overrides?.withRemoteHttpResponse ?? withRemoteHttpResponse
	};
}
async function assertVoyageResponseOk(res, context) {
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`${context}: ${res.status} ${text}`);
	}
}
function buildVoyageBatchRequest(params) {
	return {
		url: `${normalizeBatchBaseUrl(params.client)}/${params.path}`,
		ssrfPolicy: params.client.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.client, { json: true }) },
		onResponse: params.onResponse
	};
}
async function submitVoyageBatch(params) {
	const baseUrl = normalizeBatchBaseUrl(params.client);
	const inputFileId = await params.deps.uploadBatchJsonlFile({
		client: params.client,
		requests: params.requests,
		errorPrefix: "voyage batch file upload failed"
	});
	return await params.deps.postJsonWithRetry({
		url: `${baseUrl}/batches`,
		headers: buildBatchHeaders(params.client, { json: true }),
		ssrfPolicy: params.client.ssrfPolicy,
		body: {
			input_file_id: inputFileId,
			endpoint: VOYAGE_BATCH_ENDPOINT,
			completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
			request_params: {
				model: params.client.model,
				input_type: "document"
			},
			metadata: {
				source: "clawdbot-memory",
				agent: params.agentId
			}
		},
		errorPrefix: "voyage batch create failed"
	});
}
async function fetchVoyageBatchStatus(params) {
	return await params.deps.withRemoteHttpResponse(buildVoyageBatchRequest({
		client: params.client,
		path: `batches/${params.batchId}`,
		onResponse: async (res) => {
			await assertVoyageResponseOk(res, "voyage batch status failed");
			return await res.json();
		}
	}));
}
async function readVoyageBatchError(params) {
	try {
		return await params.deps.withRemoteHttpResponse(buildVoyageBatchRequest({
			client: params.client,
			path: `files/${params.errorFileId}/content`,
			onResponse: async (res) => {
				await assertVoyageResponseOk(res, "voyage batch error file content failed");
				const text = await res.text();
				if (!text.trim()) return;
				return extractBatchErrorMessage(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)));
			}
		}));
	} catch (err) {
		return formatUnavailableBatchError(err);
	}
}
async function waitForVoyageBatch(params) {
	const start = params.deps.now();
	let current = params.initial;
	while (true) {
		const status = current ?? await fetchVoyageBatchStatus({
			client: params.client,
			batchId: params.batchId,
			deps: params.deps
		});
		const state = status.status ?? "unknown";
		if (state === "completed") return resolveBatchCompletionFromStatus({
			provider: "voyage",
			batchId: params.batchId,
			status
		});
		await throwIfBatchTerminalFailure({
			provider: "voyage",
			status: {
				...status,
				id: params.batchId
			},
			readError: async (errorFileId) => await readVoyageBatchError({
				client: params.client,
				errorFileId,
				deps: params.deps
			})
		});
		if (!params.wait) throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
		if (params.deps.now() - start > params.timeoutMs) throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
		params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
		await params.deps.sleep(params.pollIntervalMs);
		current = void 0;
	}
}
async function runVoyageEmbeddingBatches(params) {
	const deps = resolveVoyageBatchDeps(params.deps);
	return await runEmbeddingBatchGroups({
		...buildEmbeddingBatchGroupOptions(params, {
			maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
			debugLabel: "memory embeddings: voyage batch submit"
		}),
		runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
			const batchInfo = await submitVoyageBatch({
				client: params.client,
				requests: group,
				agentId: params.agentId,
				deps
			});
			if (!batchInfo.id) throw new Error("voyage batch create failed: missing batch id");
			const batchId = batchInfo.id;
			params.debug?.("memory embeddings: voyage batch created", {
				batchId: batchInfo.id,
				status: batchInfo.status,
				group: groupIndex + 1,
				groups,
				requests: group.length
			});
			const completed = await resolveCompletedBatchResult({
				provider: "voyage",
				status: batchInfo,
				wait: params.wait,
				waitForBatch: async () => await waitForVoyageBatch({
					client: params.client,
					batchId,
					wait: params.wait,
					pollIntervalMs: params.pollIntervalMs,
					timeoutMs: params.timeoutMs,
					debug: params.debug,
					initial: batchInfo,
					deps
				})
			});
			const baseUrl = normalizeBatchBaseUrl(params.client);
			const errors = [];
			const remaining = new Set(group.map((request) => request.custom_id));
			await deps.withRemoteHttpResponse({
				url: `${baseUrl}/files/${completed.outputFileId}/content`,
				ssrfPolicy: params.client.ssrfPolicy,
				init: { headers: buildBatchHeaders(params.client, { json: true }) },
				onResponse: async (contentRes) => {
					if (!contentRes.ok) {
						const text = await contentRes.text();
						throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
					}
					if (!contentRes.body) return;
					const reader = createInterface({
						input: Readable.fromWeb(contentRes.body),
						terminal: false
					});
					for await (const rawLine of reader) {
						if (!rawLine.trim()) continue;
						applyEmbeddingBatchOutputLine({
							line: JSON.parse(rawLine),
							remaining,
							errors,
							byCustomId
						});
					}
				}
			});
			if (errors.length > 0) throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
			if (remaining.size > 0) throw new Error(`voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
		}
	});
}
//#endregion
export { runVoyageEmbeddingBatches as t };
