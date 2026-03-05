import { EventStream, getModel, streamSimple, validateToolArguments } from "@mariozechner/pi-ai";
import { parse } from "partial-json";

//#region src/context-compressor.ts
const COMPRESSION_LABEL = "aged-out";
const CHARS_PER_TOKEN = 4;
/**
* Rough character count across all message content blocks.
* Used to measure compression savings (not an exact tokenizer).
*/
function estimateMessageChars(messages) {
	let total = 0;
	for (const msg of messages) {
		const content = msg.content;
		if (typeof content === "string") total += content.length;
		else if (Array.isArray(content)) for (const block of content) if (isTextBlock(block)) total += block.text.length;
		else try {
			total += JSON.stringify(block).length;
		} catch {
			total += 64;
		}
	}
	return total;
}
/** Convert a char estimate to approximate tokens. */
function charsToTokens(chars) {
	return Math.round(chars / CHARS_PER_TOKEN);
}
function role(msg) {
	return msg.role ?? "";
}
function isTextBlock(block) {
	return !!block && typeof block === "object" && block.type === "text";
}
function isThinkingBlock(block) {
	const t = block.type;
	return t === "thinking" || t === "redactedThinking";
}
function isToolCallBlock(block) {
	const t = block.type;
	return t === "toolCall" || t === "tool_use";
}
/** Truncate a list of text blocks to maxChars total, returning a single text block. */
function truncateTextBlocks(blocks, maxChars, label) {
	const full = blocks.map((b) => b.text).join("\n");
	const head = full.slice(0, maxChars);
	return {
		type: "text",
		text: `${head}…[+${full.length - head.length} chars, ${label}]`
	};
}
/**
* Compresses messages older than `ageTurns` user-turns.
*
* - ToolResultMessages: text truncated to maxChars (Stage 1).
* - AssistantMessages:  text truncated to maxAssistantChars; thinking dropped (Stage 2).
* - UserMessages: unchanged.
*
* Returns a new array; never mutates the originals.
*/
function compressAgedToolResults(messages, opts = {}) {
	const ageTurns = opts.ageTurns ?? 2;
	const maxChars = opts.maxChars ?? 100;
	const maxAssistantChars = opts.maxAssistantChars ?? 300;
	const userIndices = [];
	for (let i = 0; i < messages.length; i++) if (role(messages[i]) === "user") userIndices.push(i);
	if (userIndices.length <= ageTurns) return messages;
	const cutoff = userIndices[userIndices.length - ageTurns];
	const result = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const r = role(msg);
		if (i >= cutoff) {
			result.push(msg);
			continue;
		}
		if (r === "toolResult") {
			const textBlocks = (msg.content ?? []).filter(isTextBlock);
			if (textBlocks.reduce((sum, b) => sum + b.text.length, 0) <= maxChars) result.push(msg);
			else result.push({
				...msg,
				content: [truncateTextBlocks(textBlocks, maxChars, COMPRESSION_LABEL)]
			});
			continue;
		}
		if (r === "assistant" && maxAssistantChars > 0) {
			const rawContent = msg.content ?? [];
			const textBlocks = rawContent.filter(isTextBlock);
			const toolCalls = rawContent.filter(isToolCallBlock);
			const needsTruncation = textBlocks.reduce((sum, b) => sum + b.text.length, 0) > maxAssistantChars;
			const hasThinking = rawContent.some(isThinkingBlock);
			if (!needsTruncation && !hasThinking) {
				result.push(msg);
				continue;
			}
			const newContent = [];
			if (textBlocks.length > 0) if (needsTruncation) newContent.push(truncateTextBlocks(textBlocks, maxAssistantChars, COMPRESSION_LABEL));
			else newContent.push(...textBlocks);
			newContent.push(...toolCalls);
			result.push({
				...msg,
				content: newContent
			});
			continue;
		}
		result.push(msg);
	}
	return result;
}

//#endregion
//#region src/agent-loop.ts
/**
* Start an agent loop with a new prompt message.
* Identical signature to pi-agent-core's agentLoop — drop-in replacement.
*/
function agentLoop(prompts, context, config, signal, streamFn) {
	const stream = createAgentStream();
	(async () => {
		const newMessages = [...prompts];
		const currentContext = {
			...context,
			messages: [...context.messages, ...prompts]
		};
		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({
				type: "message_start",
				message: prompt
			});
			stream.push({
				type: "message_end",
				message: prompt
			});
		}
		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();
	return stream;
}
/**
* Continue an agent loop from the current context without adding a new message.
* Identical signature to pi-agent-core's agentLoopContinue.
*/
function agentLoopContinue(context, config, signal, streamFn) {
	if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
	if (context.messages[context.messages.length - 1].role === "assistant") throw new Error("Cannot continue from message role: assistant");
	const stream = createAgentStream();
	(async () => {
		const newMessages = [];
		const currentContext = { ...context };
		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();
	return stream;
}
/**
* Simple counting semaphore for capping parallel tool executions.
* acquire() resolves immediately when a slot is free, otherwise queues.
* release() unblocks the next waiter (or increments the slot count).
*/
var Semaphore = class {
	constructor(limit) {
		this.queue = [];
		this.slots = limit;
	}
	acquire() {
		if (this.slots > 0) {
			this.slots--;
			return Promise.resolve();
		}
		return new Promise((r) => this.queue.push(r));
	}
	release() {
		const next = this.queue.shift();
		if (next) next();
		else this.slots++;
	}
};
/** Stable JSON serialisation (sorted keys) for use as cache keys. */
function stableJson(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	return `{${Object.keys(v).toSorted().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}
function toolCacheKey(toolName, args) {
	return `${toolName}\x00${stableJson(args)}`;
}
/** Combine parent signal + optional per-tool timeout into one AbortSignal. */
function makeToolSignal(parent, timeoutMs) {
	const signals = [];
	if (parent) signals.push(parent);
	if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
	if (signals.length === 0) return;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}
/** Log per-turn and cumulative token usage to stderr. */
function logTokenUsage(message, session) {
	const u = message.usage;
	if (!u) return;
	session.input += u.input ?? 0;
	session.output += u.output ?? 0;
	session.cacheRead += u.cacheRead ?? 0;
	session.cacheWrite += u.cacheWrite ?? 0;
	const totalCost = u.cost?.total ?? 0;
	const sessionTotal = session.input + session.output + session.cacheRead + session.cacheWrite;
	process.stderr.write(`[iris-tokens] turn in=${u.input} out=${u.output}` + (u.cacheRead ? ` cacheRead=${u.cacheRead}` : "") + (u.cacheWrite ? ` cacheWrite=${u.cacheWrite}` : "") + (totalCost > 0 ? ` cost=$${totalCost.toFixed(4)}` : "") + ` | session total=${sessionTotal}\n`);
}
function createAgentStream() {
	return new EventStream((event) => event.type === "agent_end", (event) => event.type === "agent_end" ? event.messages : []);
}
async function runLoop(currentContext, newMessages, config, signal, stream, streamFn) {
	let firstTurn = true;
	let pendingMessages = await config.getSteeringMessages?.() ?? [];
	const toolCache = /* @__PURE__ */ new Map();
	const sessionTokens = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools = null;
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) stream.push({ type: "turn_start" });
			else firstTurn = false;
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({
						type: "message_start",
						message
					});
					stream.push({
						type: "message_end",
						message
					});
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);
			logTokenUsage(message, sessionTokens);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({
					type: "turn_end",
					message,
					toolResults: []
				});
				stream.push({
					type: "agent_end",
					messages: newMessages
				});
				stream.end(newMessages);
				return;
			}
			hasMoreToolCalls = message.content.filter((c) => c.type === "toolCall").length > 0;
			const toolResults = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCallsParallel(currentContext.tools, message, signal, stream, config.getSteeringMessages, {
					toolTimeoutMs: config.toolTimeoutMs,
					toolCacheMs: config.toolCacheMs,
					toolCache,
					maxParallelTools: config.maxParallelTools
				});
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
			stream.push({
				type: "turn_end",
				message,
				toolResults
			});
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else pendingMessages = await config.getSteeringMessages?.() ?? [];
		}
		const followUpMessages = await config.getFollowUpMessages?.() ?? [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}
		break;
	}
	stream.push({
		type: "agent_end",
		messages: newMessages
	});
	stream.end(newMessages);
}
/** Log compression savings to stderr. Only emits when something was actually compressed. */
function logCompressionStats(beforeChars, afterChars) {
	const savedChars = beforeChars - afterChars;
	if (savedChars <= 0) return;
	const pct = Math.round(savedChars / beforeChars * 100);
	const savedTokens = charsToTokens(savedChars);
	process.stderr.write(`[iris-compress] before=${beforeChars}ch after=${afterChars}ch saved=${savedChars}ch (~${savedTokens}tok, ${pct}%)\n`);
}
async function streamAssistantResponse(context, config, signal, stream, streamFn) {
	let messages = context.messages;
	if (config.toolResultCompression !== false) {
		const opts = config.toolResultCompression ?? {
			ageTurns: 2,
			maxChars: 100,
			maxAssistantChars: 300
		};
		const beforeChars = estimateMessageChars(messages);
		messages = compressAgedToolResults(messages, opts);
		logCompressionStats(beforeChars, estimateMessageChars(messages));
	}
	if (config.transformContext) messages = await config.transformContext(messages, signal);
	const llmMessages = await config.convertToLlm(messages);
	const llmContext = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools
	};
	const streamFunction = streamFn ?? streamSimple;
	const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : void 0) ?? config.apiKey;
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal
	});
	let partialMessage = null;
	let addedPartial = false;
	for await (const event of response) switch (event.type) {
		case "start":
			partialMessage = event.partial;
			context.messages.push(partialMessage);
			addedPartial = true;
			stream.push({
				type: "message_start",
				message: { ...partialMessage }
			});
			break;
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			if (partialMessage) {
				partialMessage = event.partial;
				context.messages[context.messages.length - 1] = partialMessage;
				stream.push({
					type: "message_update",
					assistantMessageEvent: event,
					message: { ...partialMessage }
				});
			}
			break;
		case "done":
		case "error": {
			const finalMessage = await response.result();
			if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
			else context.messages.push(finalMessage);
			if (!addedPartial) stream.push({
				type: "message_start",
				message: { ...finalMessage }
			});
			stream.push({
				type: "message_end",
				message: finalMessage
			});
			return finalMessage;
		}
	}
	return response.result();
}
/**
* Execute all tool calls in parallel using Promise.allSettled.
*
* Sequential (before):  tool1 → wait → tool2 → wait → tool3 → wait  (N × T)
* Parallel  (after):    tool1 ┐
*                       tool2 ├→ wait for slowest → done              (max T)
*                       tool3 ┘
*
* Steering messages are checked BEFORE launching the batch so the user can
* still interrupt before any work begins. If the agent is mid-batch and the
* user sends a message, it will be picked up on the next turn.
*/
async function executeToolCallsParallel(tools, assistantMessage, signal, stream, getSteeringMessages, opts) {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (toolCalls.length === 0) return { toolResults: [] };
	if (getSteeringMessages) {
		const steering = await getSteeringMessages();
		if (steering.length > 0) return {
			toolResults: toolCalls.map((tc) => skipToolCall(tc, stream)),
			steeringMessages: steering
		};
	}
	for (const toolCall of toolCalls) stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments
	});
	const { toolTimeoutMs, toolCacheMs, toolCache, maxParallelTools } = opts ?? {};
	const sem = new Semaphore(maxParallelTools ?? 5);
	const toolDurations = Array.from({ length: toolCalls.length }, () => 0);
	let cacheHits = 0;
	const batchPromises = /* @__PURE__ */ new Map();
	const batchStart = Date.now();
	const executions = toolCalls.map(async (toolCall, i) => {
		const tool = tools?.find((t) => t.name === toolCall.name);
		if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
		const cacheKey = toolCacheKey(toolCall.name, toolCall.arguments);
		if (tool.cacheable && toolCache && toolCacheMs) {
			const entry = toolCache.get(cacheKey);
			const maxAge = toolCacheMs === -1 ? Infinity : toolCacheMs;
			if (entry && Date.now() - entry.ts <= maxAge) {
				cacheHits++;
				return entry.result;
			}
		}
		const existing = batchPromises.get(cacheKey);
		if (existing) return existing;
		const validatedArgs = validateToolArguments(tool, toolCall);
		const toolSignal = makeToolSignal(signal, toolTimeoutMs);
		const promise = (async () => {
			await sem.acquire();
			const toolStart = Date.now();
			try {
				const result = await tool.execute(toolCall.id, validatedArgs, toolSignal, (partialResult) => {
					stream.push({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
						partialResult
					});
				});
				if (tool.cacheable && toolCache && toolCacheMs) toolCache.set(cacheKey, {
					result,
					ts: Date.now()
				});
				return result;
			} finally {
				toolDurations[i] = Date.now() - toolStart;
				sem.release();
			}
		})();
		batchPromises.set(cacheKey, promise);
		return promise;
	});
	const settled = await Promise.allSettled(executions);
	const wall = Date.now() - batchStart;
	const logSingle = process.env["IRIS_PARALLEL_STATS"] === "always";
	if (toolCalls.length > 1 || logSingle) {
		const seqEstimate = toolDurations.reduce((a, b) => a + b, 0);
		const saved = seqEstimate - wall;
		const names = toolCalls.map((tc) => tc.name).join(",");
		const cacheStr = cacheHits > 0 ? ` cached=${cacheHits}` : "";
		const limit = maxParallelTools ?? 5;
		process.stderr.write(`[iris-parallel] n=${toolCalls.length} wall=${wall}ms seq_est=${seqEstimate}ms saved=${saved}ms${cacheStr} limit=${limit} tools=[${names}]\n`);
	}
	const results = [];
	for (let i = 0; i < toolCalls.length; i++) {
		const toolCall = toolCalls[i];
		const outcome = settled[i];
		const isError = outcome.status === "rejected";
		const result = isError ? {
			content: [{
				type: "text",
				text: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
			}],
			details: {}
		} : outcome.value;
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError
		});
		const toolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now()
		};
		results.push(toolResultMessage);
		stream.push({
			type: "message_start",
			message: toolResultMessage
		});
		stream.push({
			type: "message_end",
			message: toolResultMessage
		});
	}
	return { toolResults: results };
}
function skipToolCall(toolCall, stream) {
	const result = {
		content: [{
			type: "text",
			text: "Skipped due to queued user message."
		}],
		details: {}
	};
	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true
	});
	const msg = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now()
	};
	stream.push({
		type: "message_start",
		message: msg
	});
	stream.push({
		type: "message_end",
		message: msg
	});
	return msg;
}

//#endregion
//#region src/agent.ts
function defaultConvertToLlm(messages) {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}
var IrisAgent = class {
	constructor(opts = {}) {
		this._state = {
			systemPrompt: "",
			model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: /* @__PURE__ */ new Set(),
			error: void 0
		};
		this.listeners = /* @__PURE__ */ new Set();
		this.steeringQueue = [];
		this.followUpQueue = [];
		if (opts.initialState) this._state = {
			...this._state,
			...opts.initialState
		};
		this.convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = opts.transformContext;
		this.steeringMode = opts.steeringMode ?? "one-at-a-time";
		this.followUpMode = opts.followUpMode ?? "one-at-a-time";
		this.streamFn = opts.streamFn ?? streamSimple;
		this._sessionId = opts.sessionId;
		this.getApiKey = opts.getApiKey;
		this._thinkingBudgets = opts.thinkingBudgets;
		this._transport = opts.transport ?? "sse";
		this._maxRetryDelayMs = opts.maxRetryDelayMs;
		this._toolTimeoutMs = opts.toolTimeoutMs;
		this._toolCacheMs = opts.toolCacheMs;
		this._maxParallelTools = opts.maxParallelTools;
		this._toolResultCompression = opts.toolResultCompression;
	}
	get state() {
		return this._state;
	}
	get sessionId() {
		return this._sessionId;
	}
	set sessionId(value) {
		this._sessionId = value;
	}
	/**
	* Update parallel execution options after construction.
	* Called by the app layer to wire config values into the agent loop.
	*/
	setParallelOptions(opts) {
		if (opts.toolTimeoutMs !== void 0) this._toolTimeoutMs = opts.toolTimeoutMs;
		if (opts.toolCacheMs !== void 0) this._toolCacheMs = opts.toolCacheMs;
		if (opts.maxParallelTools !== void 0) this._maxParallelTools = opts.maxParallelTools;
		if (opts.toolResultCompression !== void 0) this._toolResultCompression = opts.toolResultCompression;
	}
	get thinkingBudgets() {
		return this._thinkingBudgets;
	}
	set thinkingBudgets(value) {
		this._thinkingBudgets = value;
	}
	get transport() {
		return this._transport;
	}
	setTransport(value) {
		this._transport = value;
	}
	get maxRetryDelayMs() {
		return this._maxRetryDelayMs;
	}
	set maxRetryDelayMs(value) {
		this._maxRetryDelayMs = value;
	}
	setSystemPrompt(v) {
		this._state.systemPrompt = v;
	}
	setModel(m) {
		this._state.model = m;
	}
	setThinkingLevel(l) {
		this._state.thinkingLevel = l;
	}
	setSteeringMode(mode) {
		this.steeringMode = mode;
	}
	getSteeringMode() {
		return this.steeringMode;
	}
	setFollowUpMode(mode) {
		this.followUpMode = mode;
	}
	getFollowUpMode() {
		return this.followUpMode;
	}
	setTools(t) {
		this._state.tools = t;
	}
	replaceMessages(ms) {
		this._state.messages = ms.slice();
	}
	appendMessage(m) {
		this._state.messages = [...this._state.messages, m];
	}
	/** Queue a steering message to interrupt the agent mid-run. */
	steer(m) {
		this.steeringQueue.push(m);
	}
	/** Queue a follow-up message to process after the agent finishes. */
	followUp(m) {
		this.followUpQueue.push(m);
	}
	clearSteeringQueue() {
		this.steeringQueue = [];
	}
	clearFollowUpQueue() {
		this.followUpQueue = [];
	}
	clearAllQueues() {
		this.steeringQueue = [];
		this.followUpQueue = [];
	}
	hasQueuedMessages() {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}
	clearMessages() {
		this._state.messages = [];
	}
	abort() {
		this.abortController?.abort();
	}
	waitForIdle() {
		return this.runningPrompt ?? Promise.resolve();
	}
	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = /* @__PURE__ */ new Set();
		this._state.error = void 0;
		this.steeringQueue = [];
		this.followUpQueue = [];
	}
	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	async prompt(input, images) {
		if (this._state.isStreaming) throw new Error("IrisAgent is already processing a prompt. Use steer() or followUp() to queue messages.");
		if (!this._state.model) throw new Error("No model configured");
		let msgs;
		if (Array.isArray(input)) msgs = input;
		else if (typeof input === "string") {
			const content = [{
				type: "text",
				text: input
			}];
			if (images?.length) content.push(...images);
			msgs = [{
				role: "user",
				content,
				timestamp: Date.now()
			}];
		} else msgs = [input];
		await this._runLoop(msgs);
	}
	async continue() {
		if (this._state.isStreaming) throw new Error("IrisAgent is already processing. Wait for completion before continuing.");
		const messages = this._state.messages;
		if (messages.length === 0) throw new Error("No messages to continue from");
		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this._dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}
			const queuedFollowUp = this._dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp);
				return;
			}
			throw new Error("Cannot continue from message role: assistant");
		}
		await this._runLoop(void 0);
	}
	async _runLoop(messages, options) {
		const model = this._state.model;
		if (!model) throw new Error("No model configured");
		this.runningPrompt = new Promise((resolve) => {
			this.resolveRunningPrompt = resolve;
		});
		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = void 0;
		const reasoning = this._state.thinkingLevel === "off" ? void 0 : this._state.thinkingLevel;
		const context = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools
		};
		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
		const config = {
			model,
			reasoning,
			sessionId: this._sessionId,
			transport: this._transport,
			thinkingBudgets: this._thinkingBudgets,
			maxRetryDelayMs: this._maxRetryDelayMs,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this._dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this._dequeueFollowUpMessages(),
			toolTimeoutMs: this._toolTimeoutMs,
			toolCacheMs: this._toolCacheMs,
			maxParallelTools: this._maxParallelTools,
			toolResultCompression: this._toolResultCompression
		};
		let partial = null;
		try {
			const stream = messages ? agentLoop(messages, context, config, this.abortController.signal, this.streamFn) : agentLoopContinue(context, config, this.abortController.signal, this.streamFn);
			for await (const event of stream) {
				switch (event.type) {
					case "message_start":
						if (event.message.role === "assistant") partial = event.message;
						this._state.streamMessage = event.message;
						break;
					case "message_update":
						if (event.message.role === "assistant") partial = event.message;
						this._state.streamMessage = event.message;
						break;
					case "message_end":
						partial = null;
						this._state.streamMessage = null;
						this.appendMessage(event.message);
						break;
					case "tool_execution_start": {
						const s = new Set(this._state.pendingToolCalls);
						s.add(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}
					case "tool_execution_end": {
						const s = new Set(this._state.pendingToolCalls);
						s.delete(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}
					case "turn_end":
						if (event.message.role === "assistant") {
							const assistantMsg = event.message;
							if (assistantMsg.errorMessage) this._state.error = assistantMsg.errorMessage;
						}
						break;
					case "agent_end":
						this._state.isStreaming = false;
						this._state.streamMessage = null;
						break;
				}
				this._emit(event);
			}
			if (partial && partial.content.length > 0) {
				if (!!partial.content.some((c) => c.type === "thinking" && c.thinking.trim().length > 0 || c.type === "text" && c.text.trim().length > 0 || c.type === "toolCall" && c.name.trim().length > 0)) this.appendMessage(partial);
			}
		} catch (err) {
			const e = err;
			const errorMsg = {
				role: "assistant",
				content: [{
					type: "text",
					text: ""
				}],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: e?.message ?? String(err),
				timestamp: Date.now()
			};
			this.appendMessage(errorMsg);
			this._state.error = e?.message ?? String(err);
			this._emit({
				type: "agent_end",
				messages: [errorMsg]
			});
		} finally {
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = /* @__PURE__ */ new Set();
			this.abortController = void 0;
			this.resolveRunningPrompt?.();
			this.runningPrompt = void 0;
			this.resolveRunningPrompt = void 0;
		}
	}
	_dequeueSteeringMessages() {
		if (this.steeringMode === "one-at-a-time") {
			if (this.steeringQueue.length > 0) {
				const first = this.steeringQueue[0];
				this.steeringQueue = this.steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.steeringQueue.slice();
		this.steeringQueue = [];
		return steering;
	}
	_dequeueFollowUpMessages() {
		if (this.followUpMode === "one-at-a-time") {
			if (this.followUpQueue.length > 0) {
				const first = this.followUpQueue[0];
				this.followUpQueue = this.followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.followUpQueue.slice();
		this.followUpQueue = [];
		return followUp;
	}
	_emit(e) {
		for (const listener of this.listeners) listener(e);
	}
};

//#endregion
//#region src/proxy.ts
function parseStreamingJson(partialJson) {
	if (!partialJson || partialJson.trim() === "") return {};
	try {
		return JSON.parse(partialJson);
	} catch {
		try {
			return parse(partialJson) ?? {};
		} catch {
			return {};
		}
	}
}
function processProxyEvent(proxyEvent, partial) {
	switch (proxyEvent.type) {
		case "start": return {
			type: "start",
			partial
		};
		case "text_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "text",
				text: ""
			};
			return {
				type: "text_start",
				contentIndex: proxyEvent.contentIndex,
				partial
			};
		case "text_delta": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "text") {
				c.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial
				};
			}
			throw new Error("Received text_delta for non-text content");
		}
		case "text_end": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "text") return {
				type: "text_end",
				contentIndex: proxyEvent.contentIndex,
				content: c.text,
				partial
			};
			throw new Error("Received text_end for non-text content");
		}
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "thinking",
				thinking: ""
			};
			return {
				type: "thinking_start",
				contentIndex: proxyEvent.contentIndex,
				partial
			};
		case "thinking_delta": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "thinking") {
				c.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}
		case "thinking_end": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "thinking") return {
				type: "thinking_end",
				contentIndex: proxyEvent.contentIndex,
				content: c.thinking,
				partial
			};
			throw new Error("Received thinking_end for non-thinking content");
		}
		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: ""
			};
			return {
				type: "toolcall_start",
				contentIndex: proxyEvent.contentIndex,
				partial
			};
		case "toolcall_delta": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "toolCall") {
				c.partialJson += proxyEvent.delta;
				c.arguments = parseStreamingJson(c.partialJson);
				partial.content[proxyEvent.contentIndex] = { ...c };
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}
		case "toolcall_end": {
			const c = partial.content[proxyEvent.contentIndex];
			if (c?.type === "toolCall") {
				const { partialJson: _p, ...toolCall } = c;
				partial.content[proxyEvent.contentIndex] = toolCall;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall,
					partial
				};
			}
			return;
		}
		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return {
				type: "done",
				reason: proxyEvent.reason,
				message: partial
			};
		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return {
				type: "error",
				reason: proxyEvent.reason,
				error: partial
			};
		default:
			console.warn(`Unhandled proxy event type: ${String(proxyEvent.type)}`);
			return;
	}
}
function streamProxy(model, context, options) {
	const stream = new EventStream((event) => event.type === "done" || event.type === "error", (event) => {
		if (event.type === "done") return event.message;
		if (event.type === "error") return event.error;
		throw new Error("Unexpected event type");
	});
	(async () => {
		const partial = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			timestamp: Date.now()
		};
		let reader;
		const abortHandler = () => {
			reader?.cancel("Request aborted by user").catch(() => {});
		};
		if (options.signal) options.signal.addEventListener("abort", abortHandler);
		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					context,
					options: {
						temperature: options.temperature,
						maxTokens: options.maxTokens,
						reasoning: options.reasoning
					}
				}),
				signal: options.signal
			});
			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = await response.json();
					if (errorData.error) errorMessage = `Proxy error: ${errorData.error}`;
				} catch {}
				throw new Error(errorMessage);
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (options.signal?.aborted) throw new Error("Request aborted by user");
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) if (line.startsWith("data: ")) {
					const data = line.slice(6).trim();
					if (data) {
						const event = processProxyEvent(JSON.parse(data), partial);
						if (event) stream.push(event);
					}
				}
			}
			if (options.signal?.aborted) throw new Error("Request aborted by user");
			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial
			});
			stream.end();
		} finally {
			if (options.signal) options.signal.removeEventListener("abort", abortHandler);
		}
	})();
	return stream;
}

//#endregion
export { IrisAgent as Agent, IrisAgent, agentLoop, agentLoopContinue, charsToTokens, compressAgedToolResults, estimateMessageChars, streamProxy };