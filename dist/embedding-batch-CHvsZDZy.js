import { C as withRemoteHttpResponse, T as formatUnavailableBatchError, _ as buildBatchHeaders, b as applyEmbeddingBatchOutputLine, d as uploadBatchJsonlFile, f as resolveBatchCompletionFromStatus, g as runEmbeddingBatchGroups, h as buildEmbeddingBatchGroupOptions, m as throwIfBatchTerminalFailure, p as resolveCompletedBatchResult, v as normalizeBatchBaseUrl, w as extractBatchErrorMessage, x as postJsonWithRetry, y as EMBEDDING_BATCH_ENDPOINT } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
//#region extensions/openai/embedding-batch.ts
const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 5e4;
async function submitOpenAiBatch(params) {
	const baseUrl = normalizeBatchBaseUrl(params.openAi);
	const inputFileId = await uploadBatchJsonlFile({
		client: params.openAi,
		requests: params.requests,
		errorPrefix: "openai batch file upload failed"
	});
	return await postJsonWithRetry({
		url: `${baseUrl}/batches`,
		headers: buildBatchHeaders(params.openAi, { json: true }),
		ssrfPolicy: params.openAi.ssrfPolicy,
		fetchImpl: params.openAi.fetchImpl,
		body: {
			input_file_id: inputFileId,
			endpoint: OPENAI_BATCH_ENDPOINT,
			completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
			metadata: {
				source: "openclaw-memory",
				agent: params.agentId
			}
		},
		errorPrefix: "openai batch create failed"
	});
}
async function fetchOpenAiBatchStatus(params) {
	return await fetchOpenAiBatchResource({
		openAi: params.openAi,
		path: `/batches/${params.batchId}`,
		errorPrefix: "openai batch status",
		parse: async (res) => await res.json()
	});
}
async function fetchOpenAiFileContent(params) {
	return await fetchOpenAiBatchResource({
		openAi: params.openAi,
		path: `/files/${params.fileId}/content`,
		errorPrefix: "openai batch file content",
		parse: async (res) => await res.text()
	});
}
async function fetchOpenAiBatchResource(params) {
	return await withRemoteHttpResponse({
		url: `${normalizeBatchBaseUrl(params.openAi)}${params.path}`,
		ssrfPolicy: params.openAi.ssrfPolicy,
		fetchImpl: params.openAi.fetchImpl,
		init: { headers: buildBatchHeaders(params.openAi, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
			}
			return await params.parse(res);
		}
	});
}
function parseOpenAiBatchOutput(text) {
	if (!text.trim()) return [];
	return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			throw new Error("OpenAI embedding batch output contained malformed JSONL");
		}
	});
}
async function readOpenAiBatchError(params) {
	try {
		return extractBatchErrorMessage(parseOpenAiBatchOutput(await fetchOpenAiFileContent({
			openAi: params.openAi,
			fileId: params.errorFileId
		})));
	} catch (err) {
		return formatUnavailableBatchError(err);
	}
}
async function waitForOpenAiBatch(params) {
	const start = Date.now();
	let current = params.initial;
	while (true) {
		const status = current ?? await fetchOpenAiBatchStatus({
			openAi: params.openAi,
			batchId: params.batchId
		});
		const state = status.status ?? "unknown";
		if (state === "completed") return resolveBatchCompletionFromStatus({
			provider: "openai",
			batchId: params.batchId,
			status
		});
		await throwIfBatchTerminalFailure({
			provider: "openai",
			status: {
				...status,
				id: params.batchId
			},
			readError: async (errorFileId) => await readOpenAiBatchError({
				openAi: params.openAi,
				errorFileId
			})
		});
		if (!params.wait) throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
		if (Date.now() - start > params.timeoutMs) throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
		params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
		current = void 0;
	}
}
async function runOpenAiEmbeddingBatches(params) {
	return await runEmbeddingBatchGroups({
		...buildEmbeddingBatchGroupOptions(params, {
			maxRequests: OPENAI_BATCH_MAX_REQUESTS,
			debugLabel: "memory embeddings: openai batch submit"
		}),
		runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
			const batchInfo = await submitOpenAiBatch({
				openAi: params.openAi,
				requests: group,
				agentId: params.agentId
			});
			if (!batchInfo.id) throw new Error("openai batch create failed: missing batch id");
			const batchId = batchInfo.id;
			params.debug?.("memory embeddings: openai batch created", {
				batchId: batchInfo.id,
				status: batchInfo.status,
				group: groupIndex + 1,
				groups,
				requests: group.length
			});
			const completed = await resolveCompletedBatchResult({
				provider: "openai",
				status: batchInfo,
				wait: params.wait,
				waitForBatch: async () => await waitForOpenAiBatch({
					openAi: params.openAi,
					batchId,
					wait: params.wait,
					pollIntervalMs: params.pollIntervalMs,
					timeoutMs: params.timeoutMs,
					debug: params.debug,
					initial: batchInfo
				})
			});
			const outputLines = parseOpenAiBatchOutput(await fetchOpenAiFileContent({
				openAi: params.openAi,
				fileId: completed.outputFileId
			}));
			const errors = [];
			const remaining = new Set(group.map((request) => request.custom_id));
			for (const line of outputLines) applyEmbeddingBatchOutputLine({
				line,
				remaining,
				errors,
				byCustomId
			});
			if (errors.length > 0) throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
			if (remaining.size > 0) throw new Error(`openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
		}
	});
}
//#endregion
export { parseOpenAiBatchOutput as n, runOpenAiEmbeddingBatches as r, OPENAI_BATCH_ENDPOINT as t };
