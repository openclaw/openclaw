import { r as buildAgentMainSessionKey } from "./session-key-Bte0mmcq.js";
import { i as isPersistentCrestodianOperation, n as executeCrestodianOperation } from "./operations-Bw7QWTg3.js";
import { n as formatCrestodianStartupMessage, r as loadCrestodianOverview } from "./overview-Be1048jt.js";
import { n as isYes, r as resolveCrestodianOperation, t as approvalQuestion } from "./dialogue-DQK7uAWs.js";
import { y as runTui } from "./tui-LVkXuSWn.js";
import { randomUUID } from "node:crypto";
//#region src/crestodian/tui-backend.ts
const CRESTODIAN_AGENT_ID = "crestodian";
const CRESTODIAN_SESSION_KEY = buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID });
function createCaptureRuntime() {
	const lines = [];
	return {
		log: (...args) => lines.push(args.join(" ")),
		error: (...args) => lines.push(args.join(" ")),
		exit: (code) => {
			throw new Error(`Crestodian operation exited with code ${String(code)}`);
		},
		read: () => lines.join("\n").trim()
	};
}
async function loadOverviewForTui(opts) {
	if (opts.deps?.loadOverview) return await opts.deps.loadOverview();
	return await loadCrestodianOverview();
}
function message(role, text) {
	return {
		role,
		content: [{
			type: "text",
			text
		}],
		timestamp: Date.now()
	};
}
function splitModelRef(ref) {
	const trimmed = ref?.trim();
	if (!trimmed) return {};
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return { model: trimmed };
	return {
		provider: trimmed.slice(0, slash),
		model: trimmed.slice(slash + 1)
	};
}
var CrestodianTuiBackend = class {
	constructor(opts, welcome) {
		this.opts = opts;
		this.connection = { url: "crestodian local" };
		this.seq = 0;
		this.pending = null;
		this.handoff = null;
		this.requestExit = null;
		this.messages = [];
		this.messages.push(message("assistant", welcome));
	}
	setRequestExitHandler(handler) {
		this.requestExit = handler;
	}
	consumeHandoff() {
		const handoff = this.handoff;
		this.handoff = null;
		return handoff;
	}
	start() {
		queueMicrotask(() => {
			this.onConnected?.();
		});
	}
	stop() {}
	async sendChat(opts) {
		const runId = opts.runId ?? randomUUID();
		const text = opts.message.trim();
		this.messages.push(message("user", opts.message));
		this.respond(runId, opts.sessionKey, text);
		return { runId };
	}
	async abortChat() {
		return {
			ok: true,
			aborted: false
		};
	}
	async loadHistory() {
		return {
			sessionId: "crestodian",
			messages: this.messages,
			thinkingLevel: "off",
			verboseLevel: "off"
		};
	}
	async listSessions() {
		const model = splitModelRef((await loadOverviewForTui(this.opts)).defaultModel);
		return {
			ts: Date.now(),
			path: "crestodian",
			count: 1,
			defaults: {
				model: model.model ?? null,
				modelProvider: model.provider ?? null,
				contextTokens: null
			},
			sessions: [{
				key: CRESTODIAN_SESSION_KEY,
				sessionId: "crestodian",
				displayName: "Crestodian",
				updatedAt: Date.now(),
				thinkingLevel: "off",
				verboseLevel: "off",
				model: model.model,
				modelProvider: model.provider
			}]
		};
	}
	async listAgents() {
		return {
			defaultId: CRESTODIAN_AGENT_ID,
			mainKey: "main",
			scope: "per-sender",
			agents: [{
				id: CRESTODIAN_AGENT_ID,
				name: "Crestodian"
			}]
		};
	}
	async patchSession(opts) {
		const model = splitModelRef(typeof opts.model === "string" ? opts.model : void 0);
		return {
			ok: true,
			path: "crestodian",
			key: CRESTODIAN_SESSION_KEY,
			entry: {
				sessionId: "crestodian",
				displayName: "Crestodian",
				updatedAt: Date.now(),
				...model.model ? { model: model.model } : {},
				...model.provider ? { modelProvider: model.provider } : {}
			},
			resolved: {
				modelProvider: model.provider,
				model: model.model
			}
		};
	}
	async resetSession() {
		this.pending = null;
		const overview = await loadOverviewForTui(this.opts);
		this.messages.splice(0, this.messages.length, message("assistant", formatCrestodianStartupMessage(overview)));
		return { ok: true };
	}
	async getGatewayStatus() {
		return (await loadOverviewForTui(this.opts)).gateway.reachable ? "Gateway reachable" : "Gateway unreachable";
	}
	async listModels() {
		return [];
	}
	nextSeq() {
		this.seq += 1;
		return this.seq;
	}
	emit(event, payload) {
		this.onEvent?.({
			event,
			payload,
			seq: this.nextSeq()
		});
	}
	emitFinal(runId, sessionKey, text) {
		const assistant = message("assistant", text || "Crestodian listened and found nothing to change.");
		this.messages.push(assistant);
		this.emit("chat", {
			runId,
			sessionKey,
			state: "final",
			message: assistant
		});
	}
	emitError(runId, sessionKey, error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		this.emit("chat", {
			runId,
			sessionKey,
			state: "error",
			errorMessage
		});
	}
	async respond(runId, sessionKey, text) {
		try {
			const reply = await this.resolveReply(text);
			this.emitFinal(runId, sessionKey, reply);
		} catch (error) {
			this.emitError(runId, sessionKey, error);
		}
	}
	async resolveReply(text) {
		if (this.pending) {
			if (isYes(text)) {
				const pending = this.pending;
				this.pending = null;
				const capture = createCaptureRuntime();
				await executeCrestodianOperation(pending, capture, {
					approved: true,
					deps: this.opts.deps
				});
				return capture.read() || "Applied. Audit entry written.";
			}
			this.pending = null;
			return "Skipped. No barnacles on config today.";
		}
		const capture = createCaptureRuntime();
		const operation = await resolveCrestodianOperation(text, capture, this.opts);
		if (operation.kind === "open-tui") {
			this.handoff = operation;
			queueMicrotask(() => this.requestExit?.());
			return "Opening your normal agent TUI. Use /crestodian there to come back.";
		}
		if (isPersistentCrestodianOperation(operation) && !this.opts.yes) {
			this.pending = operation;
			await executeCrestodianOperation(operation, capture, {
				approved: false,
				deps: this.opts.deps
			});
			return [capture.read(), approvalQuestion(operation)].filter(Boolean).join("\n\n");
		}
		await executeCrestodianOperation(operation, capture, {
			approved: this.opts.yes === true || !isPersistentCrestodianOperation(operation),
			deps: this.opts.deps
		});
		const reply = capture.read();
		if (operation.kind === "none" && reply.includes("Bye.")) queueMicrotask(() => this.requestExit?.());
		return reply;
	}
};
async function runCrestodianTui(opts, runtime) {
	let nextInput;
	for (;;) {
		const backend = new CrestodianTuiBackend(opts, formatCrestodianStartupMessage(await loadOverviewForTui(opts)));
		await (opts.runTui ?? runTui)({
			local: true,
			session: CRESTODIAN_SESSION_KEY,
			historyLimit: 200,
			backend,
			config: {},
			title: "openclaw crestodian",
			...nextInput ? { message: nextInput } : {}
		});
		const handoff = backend.consumeHandoff();
		if (!handoff) return;
		nextInput = (await executeCrestodianOperation(handoff, runtime, {
			approved: true,
			deps: opts.deps
		})).nextInput;
		if (!nextInput?.trim()) return;
	}
}
//#endregion
export { runCrestodianTui };
