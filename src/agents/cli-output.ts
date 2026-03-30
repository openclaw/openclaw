import type { CliBackendConfig } from "../config/types.js";
import { isClaudeCliProvider } from "../plugin-sdk/anthropic-cli.js";
import { isRecord } from "../utils.js";

type CliUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
};

export type CliOutput = {
	text: string;
	sessionId?: string;
	usage?: CliUsage;
};

function toCliUsage(raw: Record<string, unknown>): CliUsage | undefined {
	const pick = (key: string) =>
		typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
	const input = pick("input_tokens") ?? pick("inputTokens");
	const output = pick("output_tokens") ?? pick("outputTokens");
	const cacheRead =
		pick("cache_read_input_tokens") ??
		pick("cached_input_tokens") ??
		pick("cacheRead");
	const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
	const total = pick("total_tokens") ?? pick("total");
	if (!input && !output && !cacheRead && !cacheWrite && !total) {
		return undefined;
	}
	return { input, output, cacheRead, cacheWrite, total };
}

function collectCliText(value: unknown): string {
	if (!value) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => collectCliText(entry)).join("");
	}
	if (!isRecord(value)) {
		return "";
	}
	if (typeof value.text === "string") {
		return value.text;
	}
	if (typeof value.content === "string") {
		return value.content;
	}
	if (Array.isArray(value.content)) {
		return value.content.map((entry) => collectCliText(entry)).join("");
	}
	if (isRecord(value.message)) {
		return collectCliText(value.message);
	}
	return "";
}

function pickCliSessionId(
	parsed: Record<string, unknown>,
	backend: CliBackendConfig,
): string | undefined {
	const fields = backend.sessionIdFields ?? [
		"session_id",
		"sessionId",
		"conversation_id",
		"conversationId",
	];
	for (const field of fields) {
		const value = parsed[field];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function parseCliJson(
	raw: string,
	backend: CliBackendConfig,
): CliOutput | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const sessionId = pickCliSessionId(parsed, backend);
	const usage = isRecord(parsed.usage) ? toCliUsage(parsed.usage) : undefined;
	const text =
		collectCliText(parsed.message) ||
		collectCliText(parsed.content) ||
		collectCliText(parsed.result) ||
		collectCliText(parsed);
	return { text: text.trim(), sessionId, usage };
}

function parseClaudeCliJsonlResult(params: {
	providerId: string;
	parsed: Record<string, unknown>;
	sessionId?: string;
	usage?: CliUsage;
}): CliOutput | null {
	if (!isClaudeCliProvider(params.providerId)) {
		return null;
	}
	if (
		typeof params.parsed.type === "string" &&
		params.parsed.type === "result" &&
		typeof params.parsed.result === "string"
	) {
		const resultText = params.parsed.result.trim();
		if (resultText) {
			return {
				text: resultText,
				sessionId: params.sessionId,
				usage: params.usage,
			};
		}
		// Claude may finish with an empty result after tool-only work. Keep the
		// resolved session handle and usage instead of dropping them.
		return { text: "", sessionId: params.sessionId, usage: params.usage };
	}
	return null;
}

export function parseCliJsonl(
	raw: string,
	backend: CliBackendConfig,
	providerId: string,
): CliOutput | null {
	const lines = raw
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		return null;
	}
	let sessionId: string | undefined;
	let usage: CliUsage | undefined;
	const texts: string[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) {
			continue;
		}
		if (!sessionId) {
			sessionId = pickCliSessionId(parsed, backend);
		}
		if (!sessionId && typeof parsed.thread_id === "string") {
			sessionId = parsed.thread_id.trim();
		}
		if (isRecord(parsed.usage)) {
			usage = toCliUsage(parsed.usage) ?? usage;
		}

		const claudeResult = parseClaudeCliJsonlResult({
			providerId,
			parsed,
			sessionId,
			usage,
		});
		if (claudeResult) {
			return claudeResult;
		}

		const item = isRecord(parsed.item) ? parsed.item : null;
		if (item && typeof item.text === "string") {
			const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
			if (!type || type.includes("message")) {
				texts.push(item.text);
			}
		}
	}
	const text = texts.join("\n").trim();
	if (!text) {
		return null;
	}
	return { text, sessionId, usage };
}

export function parseCliOutput(params: {
	raw: string;
	backend: CliBackendConfig;
	providerId: string;
	outputMode?: "json" | "jsonl" | "text";
	fallbackSessionId?: string;
}): CliOutput {
	const outputMode = params.outputMode ?? "text";
	if (outputMode === "text") {
		return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
	}
	if (outputMode === "jsonl") {
		return (
			parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
				text: params.raw.trim(),
				sessionId: params.fallbackSessionId,
			}
		);
	}
	return (
		parseCliJson(params.raw, params.backend) ?? {
			text: params.raw.trim(),
			sessionId: params.fallbackSessionId,
		}
	);
}
