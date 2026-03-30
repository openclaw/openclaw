import {
	OPENAI_BATCH_ENDPOINT,
	runOpenAiEmbeddingBatches,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MemoryChunk } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function createOpenAIEmbeddingProviderMock(params: {
	embedQuery: (input: string) => Promise<number[]>;
	embedBatch: (input: string[]) => Promise<number[][]>;
}) {
	const openAiClient = {
		baseUrl: "https://api.openai.com/v1",
		headers: {
			Authorization: "Bearer test",
			"Content-Type": "application/json",
		},
		model: "text-embedding-3-small",
	};
	return {
		requestedProvider: "openai",
		provider: {
			id: "openai",
			model: "text-embedding-3-small",
			embedQuery: params.embedQuery,
			embedBatch: params.embedBatch,
		},
		runtime: {
			id: "openai",
			cacheKeyData: {
				provider: "openai",
				baseUrl: openAiClient.baseUrl,
				model: openAiClient.model,
			},
			batchEmbed: async (options: {
				agentId: string;
				chunks: MemoryChunk[];
				wait: boolean;
				concurrency: number;
				pollIntervalMs: number;
				timeoutMs: number;
				debug: (message: string, data?: Record<string, unknown>) => void;
			}) => {
				const byCustomId = await runOpenAiEmbeddingBatches({
					openAi: openAiClient,
					agentId: options.agentId,
					requests: options.chunks.map((chunk: MemoryChunk, index: number) => ({
						custom_id: String(index),
						method: "POST",
						url: OPENAI_BATCH_ENDPOINT,
						body: {
							model: openAiClient.model,
							input: chunk.text,
						},
					})),
					wait: options.wait,
					concurrency: options.concurrency,
					pollIntervalMs: options.pollIntervalMs,
					timeoutMs: options.timeoutMs,
					debug: options.debug,
				});
				return options.chunks.map(
					(_: MemoryChunk, index: number) =>
						byCustomId.get(String(index)) ?? [],
				);
			},
		},
	};
}
