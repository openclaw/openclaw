import { postTrustedWebToolsJson } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeXaiModelId } from "../model-id.js";
import {
	extractXaiWebSearchContent,
	type XaiWebSearchResponse,
} from "./web-search-shared.js";

export const XAI_CODE_EXECUTION_ENDPOINT = "https://api.x.ai/v1/responses";
export const XAI_DEFAULT_CODE_EXECUTION_MODEL = "grok-4-1-fast";

export type XaiCodeExecutionConfig = {
	apiKey?: unknown;
	model?: unknown;
	maxTurns?: unknown;
};

export type XaiCodeExecutionResponse = XaiWebSearchResponse & {
	output?: Array<{
		type?: string;
	}>;
};

export type XaiCodeExecutionResult = {
	content: string;
	citations: string[];
	usedCodeExecution: boolean;
	outputTypes: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveXaiCodeExecutionConfig(
	config?: Record<string, unknown>,
): XaiCodeExecutionConfig {
	return isRecord(config) ? (config as XaiCodeExecutionConfig) : {};
}

export function resolveXaiCodeExecutionModel(
	config?: Record<string, unknown>,
): string {
	const resolved = resolveXaiCodeExecutionConfig(config);
	return typeof resolved.model === "string" && resolved.model.trim()
		? normalizeXaiModelId(resolved.model.trim())
		: XAI_DEFAULT_CODE_EXECUTION_MODEL;
}

export function resolveXaiCodeExecutionMaxTurns(
	config?: Record<string, unknown>,
): number | undefined {
	const raw = resolveXaiCodeExecutionConfig(config).maxTurns;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return undefined;
	}
	const normalized = Math.trunc(raw);
	return normalized > 0 ? normalized : undefined;
}

export function buildXaiCodeExecutionPayload(params: {
	task: string;
	model: string;
	tookMs: number;
	content: string;
	citations: string[];
	usedCodeExecution: boolean;
	outputTypes: string[];
}): Record<string, unknown> {
	return {
		task: params.task,
		provider: "xai",
		model: params.model,
		tookMs: params.tookMs,
		content: params.content,
		citations: params.citations,
		usedCodeExecution: params.usedCodeExecution,
		outputTypes: params.outputTypes,
	};
}

export async function requestXaiCodeExecution(params: {
	apiKey: string;
	model: string;
	timeoutSeconds: number;
	maxTurns?: number;
	task: string;
}): Promise<XaiCodeExecutionResult> {
	return await postTrustedWebToolsJson(
		{
			url: XAI_CODE_EXECUTION_ENDPOINT,
			timeoutSeconds: params.timeoutSeconds,
			apiKey: params.apiKey,
			body: {
				model: params.model,
				input: [{ role: "user", content: params.task }],
				tools: [{ type: "code_interpreter" }],
				...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
			},
			errorLabel: "xAI",
		},
		async (response) => {
			const data = (await response.json()) as XaiCodeExecutionResponse;
			const { text, annotationCitations } = extractXaiWebSearchContent(data);
			const outputTypes = Array.isArray(data.output)
				? [
						...new Set(
							data.output
								.map((entry) => entry?.type)
								.filter((value): value is string => Boolean(value)),
						),
					]
				: [];
			const citations =
				Array.isArray(data.citations) && data.citations.length > 0
					? data.citations
					: annotationCitations;
			return {
				content: text ?? "No response",
				citations,
				usedCodeExecution: outputTypes.includes("code_interpreter_call"),
				outputTypes,
			};
		},
	);
}

export const __testing = {
	buildXaiCodeExecutionPayload,
	requestXaiCodeExecution,
	resolveXaiCodeExecutionConfig,
	resolveXaiCodeExecutionMaxTurns,
	resolveXaiCodeExecutionModel,
	XAI_DEFAULT_CODE_EXECUTION_MODEL,
} as const;
