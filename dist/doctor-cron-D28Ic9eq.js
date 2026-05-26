import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, l as normalizeOptionalStringifiedId, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { At as boolean } from "./schemas-Del5uzR8.js";
import { B as MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "./dreaming-CxCxWYoC.js";
import { i as saveCronStore, r as resolveCronStorePath, t as loadCronStore } from "./store-PoorarMW.js";
import { i as TrimmedNonEmptyStringFieldSchema, n as LowercaseNonEmptyStringFieldSchema, o as parseOptionalField, t as DeliveryThreadIdFieldSchema } from "./delivery-field-schemas-BqP7BUbz.js";
import { i as parseAbsoluteTimeMs, r as resolveDefaultCronStaggerMs, t as normalizeCronStaggerMs } from "./stagger-Bn6ApiDa.js";
import { t as inferLegacyName } from "./normalize-CV8XB8wE.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as getInvalidPersistedCronJobReason } from "./persisted-shape-DyK3Ydhz.js";
import { t as coerceFiniteScheduleNumber } from "./schedule-xgcX1vdP.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
//#region src/commands/doctor-cron-dreaming-payload-migration.ts
function isManagedDreamingJob(raw) {
	if (normalizeOptionalString(raw.description)?.includes("[managed-by=memory-core.short-term-promotion]")) return true;
	if (normalizeOptionalString(raw.name) !== "Memory Dreaming Promotion") return false;
	const payload = raw.payload ?? void 0;
	const payloadKind = normalizeOptionalLowercaseString(payload?.kind);
	if (payloadKind === "systemevent") return normalizeOptionalString(payload?.text) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT;
	if (payloadKind === "agentturn") return normalizeOptionalString(payload?.message) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT;
	return false;
}
function isStaleDreamingJob(raw) {
	if (normalizeOptionalLowercaseString(raw.sessionTarget) !== "isolated") return true;
	const payload = raw.payload ?? void 0;
	if (normalizeOptionalLowercaseString(payload?.kind) !== "agentturn") return true;
	if (payload?.lightContext !== true) return true;
	if (normalizeOptionalLowercaseString((raw.delivery ?? void 0)?.mode) !== "none") return true;
	return false;
}
function rewriteDreamingJobShape(raw) {
	raw.sessionTarget = "isolated";
	raw.payload = {
		kind: "agentTurn",
		message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
		lightContext: true
	};
	raw.delivery = { mode: "none" };
}
function migrateLegacyDreamingPayloadShape(jobs) {
	let rewrittenCount = 0;
	for (const raw of jobs) {
		if (!isManagedDreamingJob(raw)) continue;
		if (!isStaleDreamingJob(raw)) continue;
		rewriteDreamingJobShape(raw);
		rewrittenCount += 1;
	}
	return {
		changed: rewrittenCount > 0,
		rewrittenCount
	};
}
function countStaleDreamingJobs(jobs) {
	let count = 0;
	for (const raw of jobs) if (isManagedDreamingJob(raw) && isStaleDreamingJob(raw)) count += 1;
	return count;
}
//#endregion
//#region src/commands/doctor-cron-legacy-delivery.ts
function parseLegacyDeliveryHintsInput(payload) {
	return {
		deliver: parseOptionalField(boolean(), payload.deliver),
		bestEffortDeliver: parseOptionalField(boolean(), payload.bestEffortDeliver),
		channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.channel),
		provider: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.provider),
		to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, payload.to),
		threadId: parseOptionalField(DeliveryThreadIdFieldSchema.transform((value) => String(value)), payload.threadId)
	};
}
function hasLegacyDeliveryHints(payload) {
	const hints = parseLegacyDeliveryHintsInput(payload);
	return hints.deliver !== void 0 || hints.bestEffortDeliver !== void 0 || hints.channel !== void 0 || hints.provider !== void 0 || hints.to !== void 0 || hints.threadId !== void 0;
}
function buildDeliveryFromLegacyPayload(payload) {
	const hints = parseLegacyDeliveryHintsInput(payload);
	const next = { mode: hints.deliver === false ? "none" : "announce" };
	if (hints.channel ?? hints.provider) next.channel = hints.channel ?? hints.provider;
	if (hints.to) next.to = hints.to;
	if (hints.threadId) next.threadId = hints.threadId;
	if (hints.bestEffortDeliver !== void 0) next.bestEffort = hints.bestEffortDeliver;
	return next;
}
function buildDeliveryPatchFromLegacyPayload(payload) {
	const hints = parseLegacyDeliveryHintsInput(payload);
	const next = {};
	let hasPatch = false;
	if (hints.deliver === false) {
		next.mode = "none";
		hasPatch = true;
	} else if (hints.deliver === true || hints.channel || hints.provider || hints.to || hints.threadId || hints.bestEffortDeliver !== void 0) {
		next.mode = "announce";
		hasPatch = true;
	}
	if (hints.channel ?? hints.provider) {
		next.channel = hints.channel ?? hints.provider;
		hasPatch = true;
	}
	if (hints.to) {
		next.to = hints.to;
		hasPatch = true;
	}
	if (hints.threadId) {
		next.threadId = hints.threadId;
		hasPatch = true;
	}
	if (hints.bestEffortDeliver !== void 0) {
		next.bestEffort = hints.bestEffortDeliver;
		hasPatch = true;
	}
	return hasPatch ? next : null;
}
function mergeLegacyDeliveryInto(delivery, payload) {
	const patch = buildDeliveryPatchFromLegacyPayload(payload);
	if (!patch) return {
		delivery,
		mutated: false
	};
	const next = { ...delivery };
	let mutated = false;
	if ("mode" in patch && patch.mode !== next.mode) {
		next.mode = patch.mode;
		mutated = true;
	}
	if ("channel" in patch && patch.channel !== next.channel) {
		next.channel = patch.channel;
		mutated = true;
	}
	if ("to" in patch && patch.to !== next.to) {
		next.to = patch.to;
		mutated = true;
	}
	if ("threadId" in patch && patch.threadId !== next.threadId) {
		next.threadId = patch.threadId;
		mutated = true;
	}
	if ("bestEffort" in patch && patch.bestEffort !== next.bestEffort) {
		next.bestEffort = patch.bestEffort;
		mutated = true;
	}
	return {
		delivery: next,
		mutated
	};
}
function normalizeLegacyDeliveryInput(params) {
	if (!params.payload || !hasLegacyDeliveryHints(params.payload)) return {
		delivery: params.delivery ?? void 0,
		mutated: false
	};
	const nextDelivery = params.delivery ? mergeLegacyDeliveryInto(params.delivery, params.payload) : {
		delivery: buildDeliveryFromLegacyPayload(params.payload),
		mutated: true
	};
	stripLegacyDeliveryFields(params.payload);
	return {
		delivery: nextDelivery.delivery,
		mutated: true
	};
}
function stripLegacyDeliveryFields(payload) {
	if ("deliver" in payload) delete payload.deliver;
	if ("channel" in payload) delete payload.channel;
	if ("provider" in payload) delete payload.provider;
	if ("to" in payload) delete payload.to;
	if ("threadId" in payload) delete payload.threadId;
	if ("bestEffortDeliver" in payload) delete payload.bestEffortDeliver;
}
//#endregion
//#region src/commands/doctor-cron-payload-migration.ts
function toCanonicalOpenAIModelRef(value) {
	const raw = readStringValue(value);
	if (typeof raw !== "string") return;
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return;
	if (trimmed.slice(0, slash).trim().toLowerCase() !== "openai-codex") return;
	const model = trimmed.slice(slash + 1).trim();
	return model ? `openai/${model}` : void 0;
}
function normalizeChannel(value) {
	return normalizeOptionalLowercaseString(value) ?? "";
}
function hasLegacyOpenAICodexCronModelRef(payload) {
	if (toCanonicalOpenAIModelRef(payload.model)) return true;
	const fallbacks = payload.fallbacks;
	return Array.isArray(fallbacks) && fallbacks.some((fallback) => toCanonicalOpenAIModelRef(fallback));
}
function migrateLegacyOpenAICodexModelRefs(payload) {
	let mutated = false;
	const model = toCanonicalOpenAIModelRef(payload.model);
	if (model && payload.model !== model) {
		payload.model = model;
		mutated = true;
	}
	const fallbacks = payload.fallbacks;
	if (Array.isArray(fallbacks)) {
		const next = fallbacks.map((fallback) => toCanonicalOpenAIModelRef(fallback) ?? fallback);
		if (next.some((fallback, index) => fallback !== fallbacks[index])) {
			payload.fallbacks = next;
			mutated = true;
		}
	}
	return mutated;
}
function migrateLegacyCronPayload(payload) {
	let mutated = false;
	const channelValue = readStringValue(payload.channel);
	const providerValue = readStringValue(payload.provider);
	const nextChannel = typeof channelValue === "string" && channelValue.trim().length > 0 ? normalizeChannel(channelValue) : typeof providerValue === "string" && providerValue.trim().length > 0 ? normalizeChannel(providerValue) : "";
	if (nextChannel) {
		if (channelValue !== nextChannel) {
			payload.channel = nextChannel;
			mutated = true;
		}
	}
	if ("provider" in payload) {
		delete payload.provider;
		mutated = true;
	}
	if (migrateLegacyOpenAICodexModelRefs(payload)) mutated = true;
	return mutated;
}
//#endregion
//#region src/commands/doctor-cron-store-migration.ts
function incrementIssue(issues, key) {
	issues[key] = (issues[key] ?? 0) + 1;
}
function normalizeStoredCronJobIdentity(raw) {
	const hadIdKey = "id" in raw;
	const hadJobIdKey = "jobId" in raw;
	const id = normalizeOptionalStringifiedId(raw.id);
	const legacyJobId = normalizeOptionalStringifiedId(raw.jobId);
	const canonicalId = id ?? legacyJobId ?? `cron-${randomUUID()}`;
	const nonStringIdIssue = hadIdKey && raw.id != null && typeof raw.id !== "string";
	const missingIdIssue = !id && !legacyJobId;
	let mutated = false;
	if (raw.id !== canonicalId) {
		raw.id = canonicalId;
		mutated = true;
	}
	if (hadJobIdKey) {
		delete raw.jobId;
		mutated = true;
	}
	return {
		mutated,
		legacyJobIdIssue: hadJobIdKey,
		missingIdIssue,
		nonStringIdIssue
	};
}
function normalizePayloadKind(payload) {
	const raw = normalizeOptionalLowercaseString(payload.kind) ?? "";
	if (raw === "agentturn") {
		if (payload.kind !== "agentTurn") {
			payload.kind = "agentTurn";
			return true;
		}
		return false;
	}
	if (raw === "systemevent") {
		if (payload.kind !== "systemEvent") {
			payload.kind = "systemEvent";
			return true;
		}
		return false;
	}
	return false;
}
function inferPayloadIfMissing(raw) {
	const message = normalizeOptionalString(raw.message) ?? "";
	const text = normalizeOptionalString(raw.text) ?? "";
	const command = normalizeOptionalString(raw.command) ?? "";
	if (message) {
		raw.payload = {
			kind: "agentTurn",
			message
		};
		return true;
	}
	if (text) {
		raw.payload = {
			kind: "systemEvent",
			text
		};
		return true;
	}
	if (command) {
		raw.payload = {
			kind: "systemEvent",
			text: command
		};
		return true;
	}
	return false;
}
function copyTopLevelAgentTurnFields(raw, payload) {
	let mutated = false;
	const copyTrimmedString = (field) => {
		if (normalizeOptionalString(payload[field])) return;
		const value = normalizeOptionalString(raw[field]);
		if (value) {
			payload[field] = value;
			mutated = true;
		}
	};
	copyTrimmedString("model");
	copyTrimmedString("thinking");
	if (typeof payload.timeoutSeconds !== "number" && typeof raw.timeoutSeconds === "number" && Number.isFinite(raw.timeoutSeconds)) {
		payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
		mutated = true;
	}
	if (typeof payload.allowUnsafeExternalContent !== "boolean" && typeof raw.allowUnsafeExternalContent === "boolean") {
		payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
		mutated = true;
	}
	if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
		payload.deliver = raw.deliver;
		mutated = true;
	}
	const channel = normalizeOptionalString(raw.channel);
	if (typeof payload.channel !== "string" && channel) {
		payload.channel = channel;
		mutated = true;
	}
	const to = normalizeOptionalString(raw.to);
	if (typeof payload.to !== "string" && to) {
		payload.to = to;
		mutated = true;
	}
	const rawThreadId = normalizeOptionalString(raw.threadId);
	if (!("threadId" in payload) && (typeof raw.threadId === "number" && Number.isFinite(raw.threadId) || Boolean(rawThreadId))) {
		payload.threadId = rawThreadId ?? raw.threadId;
		mutated = true;
	}
	if (typeof payload.bestEffortDeliver !== "boolean" && typeof raw.bestEffortDeliver === "boolean") {
		payload.bestEffortDeliver = raw.bestEffortDeliver;
		mutated = true;
	}
	const provider = normalizeOptionalString(raw.provider);
	if (typeof payload.provider !== "string" && provider) {
		payload.provider = provider;
		mutated = true;
	}
	return mutated;
}
function stripLegacyTopLevelFields(raw) {
	if ("model" in raw) delete raw.model;
	if ("thinking" in raw) delete raw.thinking;
	if ("timeoutSeconds" in raw) delete raw.timeoutSeconds;
	if ("allowUnsafeExternalContent" in raw) delete raw.allowUnsafeExternalContent;
	if ("message" in raw) delete raw.message;
	if ("text" in raw) delete raw.text;
	if ("deliver" in raw) delete raw.deliver;
	if ("channel" in raw) delete raw.channel;
	if ("to" in raw) delete raw.to;
	if ("threadId" in raw) delete raw.threadId;
	if ("bestEffortDeliver" in raw) delete raw.bestEffortDeliver;
	if ("provider" in raw) delete raw.provider;
	if ("command" in raw) delete raw.command;
	if ("timeout" in raw) delete raw.timeout;
}
function normalizeStoredCronJobs(jobs) {
	const issues = {};
	let mutated = false;
	const keptJobs = [];
	for (const raw of jobs) {
		const jobIssues = /* @__PURE__ */ new Set();
		const trackIssue = (key) => {
			if (jobIssues.has(key)) return;
			jobIssues.add(key);
			incrementIssue(issues, key);
		};
		const state = raw.state;
		if (!state || typeof state !== "object" || Array.isArray(state)) {
			raw.state = {};
			mutated = true;
		}
		const idNorm = normalizeStoredCronJobIdentity(raw);
		if (idNorm.mutated) mutated = true;
		if (idNorm.legacyJobIdIssue) trackIssue("jobId");
		if (idNorm.missingIdIssue) trackIssue("missingId");
		if (idNorm.nonStringIdIssue) trackIssue("nonStringId");
		if (typeof raw.schedule === "string") {
			raw.schedule = {
				kind: "cron",
				expr: raw.schedule.trim()
			};
			mutated = true;
			trackIssue("legacyScheduleString");
		}
		const nameRaw = raw.name;
		if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
			raw.name = inferLegacyName({
				schedule: raw.schedule,
				payload: raw.payload
			});
			mutated = true;
		} else raw.name = nameRaw.trim();
		const desc = normalizeOptionalString(raw.description);
		if (raw.description !== desc) {
			raw.description = desc;
			mutated = true;
		}
		if ("sessionKey" in raw) {
			const sessionKey = typeof raw.sessionKey === "string" ? normalizeOptionalString(raw.sessionKey) : void 0;
			if (raw.sessionKey !== sessionKey) {
				raw.sessionKey = sessionKey;
				mutated = true;
			}
		}
		if (typeof raw.enabled !== "boolean") {
			raw.enabled = true;
			mutated = true;
		}
		const wakeModeRaw = normalizeOptionalLowercaseString(raw.wakeMode) ?? "";
		if (wakeModeRaw === "next-heartbeat") {
			if (raw.wakeMode !== "next-heartbeat") {
				raw.wakeMode = "next-heartbeat";
				mutated = true;
			}
		} else if (wakeModeRaw === "now") {
			if (raw.wakeMode !== "now") {
				raw.wakeMode = "now";
				mutated = true;
			}
		} else {
			raw.wakeMode = "now";
			mutated = true;
		}
		const payload = raw.payload;
		if ((!payload || typeof payload !== "object" || Array.isArray(payload)) && inferPayloadIfMissing(raw)) {
			mutated = true;
			trackIssue("legacyTopLevelPayloadFields");
		}
		const payloadRecord = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : null;
		if (payloadRecord) {
			if (normalizePayloadKind(payloadRecord)) {
				mutated = true;
				trackIssue("legacyPayloadKind");
			}
			if (!payloadRecord.kind) {
				if (normalizeOptionalString(payloadRecord.message)) {
					payloadRecord.kind = "agentTurn";
					mutated = true;
					trackIssue("legacyPayloadKind");
				} else if (normalizeOptionalString(payloadRecord.text)) {
					payloadRecord.kind = "systemEvent";
					mutated = true;
					trackIssue("legacyPayloadKind");
				}
			}
			if (payloadRecord.kind === "agentTurn" && copyTopLevelAgentTurnFields(raw, payloadRecord)) mutated = true;
		}
		const hadLegacyTopLevelPayloadFields = "model" in raw || "thinking" in raw || "timeoutSeconds" in raw || "allowUnsafeExternalContent" in raw || "message" in raw || "text" in raw || "command" in raw || "timeout" in raw;
		const hadLegacyTopLevelDeliveryFields = "deliver" in raw || "channel" in raw || "to" in raw || "threadId" in raw || "bestEffortDeliver" in raw || "provider" in raw;
		if (hadLegacyTopLevelPayloadFields || hadLegacyTopLevelDeliveryFields) {
			stripLegacyTopLevelFields(raw);
			mutated = true;
			if (hadLegacyTopLevelPayloadFields) trackIssue("legacyTopLevelPayloadFields");
			if (hadLegacyTopLevelDeliveryFields) trackIssue("legacyTopLevelDeliveryFields");
		}
		if (payloadRecord) {
			const hadLegacyPayloadProvider = Boolean(normalizeOptionalString(payloadRecord.provider));
			const hadLegacyPayloadCodexModel = hasLegacyOpenAICodexCronModelRef(payloadRecord);
			if (migrateLegacyCronPayload(payloadRecord)) {
				mutated = true;
				if (hadLegacyPayloadCodexModel) trackIssue("legacyPayloadCodexModel");
				if (hadLegacyPayloadProvider) trackIssue("legacyPayloadProvider");
			}
		}
		const schedule = raw.schedule;
		if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
			const sched = schedule;
			const kind = normalizeOptionalLowercaseString(sched.kind) ?? "";
			if (!kind && ("at" in sched || "atMs" in sched)) {
				sched.kind = "at";
				mutated = true;
			}
			const atRaw = normalizeOptionalString(sched.at) ?? "";
			const atMsRaw = sched.atMs;
			const parsedAtMs = typeof atMsRaw === "number" ? atMsRaw : typeof atMsRaw === "string" ? parseAbsoluteTimeMs(atMsRaw) : atRaw ? parseAbsoluteTimeMs(atRaw) : null;
			if (parsedAtMs !== null) {
				sched.at = new Date(parsedAtMs).toISOString();
				if ("atMs" in sched) delete sched.atMs;
				mutated = true;
			}
			const everyMsRaw = sched.everyMs;
			const everyMsCoerced = coerceFiniteScheduleNumber(everyMsRaw);
			const everyMs = everyMsCoerced !== void 0 ? Math.floor(everyMsCoerced) : null;
			if (everyMs !== null && everyMsRaw !== everyMs) {
				sched.everyMs = everyMs;
				mutated = true;
			}
			if ((kind === "every" || sched.kind === "every") && everyMs !== null) {
				const anchorRaw = sched.anchorMs;
				const anchorCoerced = coerceFiniteScheduleNumber(anchorRaw);
				const normalizedAnchor = anchorCoerced !== void 0 ? Math.max(0, Math.floor(anchorCoerced)) : typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs) ? Math.max(0, Math.floor(raw.createdAtMs)) : typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) ? Math.max(0, Math.floor(raw.updatedAtMs)) : null;
				if (normalizedAnchor !== null && anchorRaw !== normalizedAnchor) {
					sched.anchorMs = normalizedAnchor;
					mutated = true;
				}
			}
			const exprRaw = normalizeOptionalString(sched.expr) ?? "";
			const legacyCronRaw = normalizeOptionalString(sched.cron) ?? "";
			let normalizedExpr = exprRaw;
			if (!normalizedExpr && legacyCronRaw) {
				normalizedExpr = legacyCronRaw;
				sched.expr = normalizedExpr;
				mutated = true;
				trackIssue("legacyScheduleCron");
			}
			if (typeof sched.expr === "string" && sched.expr !== normalizedExpr) {
				sched.expr = normalizedExpr;
				mutated = true;
			}
			if ("cron" in sched) {
				delete sched.cron;
				mutated = true;
				trackIssue("legacyScheduleCron");
			}
			if ((kind === "cron" || sched.kind === "cron") && normalizedExpr) {
				const explicitStaggerMs = normalizeCronStaggerMs(sched.staggerMs);
				const defaultStaggerMs = resolveDefaultCronStaggerMs(normalizedExpr);
				const targetStaggerMs = explicitStaggerMs ?? defaultStaggerMs;
				if (targetStaggerMs === void 0) {
					if ("staggerMs" in sched) {
						delete sched.staggerMs;
						mutated = true;
					}
				} else if (sched.staggerMs !== targetStaggerMs) {
					sched.staggerMs = targetStaggerMs;
					mutated = true;
				}
			}
		}
		const delivery = raw.delivery;
		if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
			const modeRaw = delivery.mode;
			if (typeof modeRaw === "string") {
				if ((normalizeOptionalLowercaseString(modeRaw) ?? "") === "deliver") {
					delivery.mode = "announce";
					mutated = true;
					trackIssue("legacyDeliveryMode");
				}
			} else if (modeRaw === void 0 || modeRaw === null) {
				delivery.mode = "announce";
				mutated = true;
			}
		}
		const isolation = raw.isolation;
		if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
			delete raw.isolation;
			mutated = true;
		}
		const payloadKind = payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
		const rawSessionTarget = normalizeOptionalString(raw.sessionTarget) ?? "";
		const loweredSessionTarget = normalizeLowercaseStringOrEmpty(rawSessionTarget);
		if (loweredSessionTarget === "main" || loweredSessionTarget === "isolated") {
			if (raw.sessionTarget !== loweredSessionTarget) {
				raw.sessionTarget = loweredSessionTarget;
				mutated = true;
			}
		} else if (loweredSessionTarget.startsWith("session:")) {
			const customSessionId = rawSessionTarget.slice(8).trim();
			if (customSessionId) {
				const normalizedSessionTarget = `session:${customSessionId}`;
				if (raw.sessionTarget !== normalizedSessionTarget) {
					raw.sessionTarget = normalizedSessionTarget;
					mutated = true;
				}
			}
		} else if (loweredSessionTarget === "current") {
			if (raw.sessionTarget !== "isolated") {
				raw.sessionTarget = "isolated";
				mutated = true;
			}
		} else {
			const inferredSessionTarget = payloadKind === "agentTurn" ? "isolated" : "main";
			if (raw.sessionTarget !== inferredSessionTarget) {
				raw.sessionTarget = inferredSessionTarget;
				mutated = true;
			}
		}
		const sessionTarget = normalizeOptionalLowercaseString(raw.sessionTarget) ?? "";
		const isIsolatedAgentTurn = sessionTarget === "isolated" || sessionTarget === "current" || sessionTarget.startsWith("session:") || sessionTarget === "" && payloadKind === "agentTurn";
		const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
		const normalizedLegacy = normalizeLegacyDeliveryInput({
			delivery: hasDelivery ? delivery : null,
			payload: payloadRecord
		});
		if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
			if (!hasDelivery && normalizedLegacy.delivery) {
				raw.delivery = normalizedLegacy.delivery;
				mutated = true;
			} else if (!hasDelivery) {
				raw.delivery = { mode: "announce" };
				mutated = true;
			} else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
				raw.delivery = normalizedLegacy.delivery;
				mutated = true;
			}
		} else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
			raw.delivery = normalizedLegacy.delivery;
			mutated = true;
		}
		const invalidPersistedReason = getInvalidPersistedCronJobReason(raw);
		if (invalidPersistedReason === "missing-schedule" || invalidPersistedReason === "invalid-schedule") {
			trackIssue("invalidSchedule");
			mutated = true;
			continue;
		}
		if (invalidPersistedReason === "missing-payload" || invalidPersistedReason === "invalid-payload") {
			trackIssue("invalidPayload");
			mutated = true;
			continue;
		}
		keptJobs.push(raw);
	}
	if (keptJobs.length !== jobs.length) jobs.splice(0, jobs.length, ...keptJobs);
	return {
		issues,
		jobs,
		mutated
	};
}
//#endregion
//#region src/commands/doctor-cron.ts
const execFileAsync = promisify(execFile);
const LEGACY_WHATSAPP_HEALTH_SCRIPT_RE = /(?:^|\s)(?:"[^"]*ensure-whatsapp\.sh"|'[^']*ensure-whatsapp\.sh'|[^\s#;|&]*ensure-whatsapp\.sh)\b/u;
const CRON_MODEL_OVERRIDE_EXAMPLE_LIMIT = 3;
function pluralize(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function formatLegacyIssuePreview(issues) {
	const lines = [];
	if (issues.jobId) lines.push(`- ${pluralize(issues.jobId, "job")} still uses legacy \`jobId\``);
	if (issues.missingId) lines.push(`- ${pluralize(issues.missingId, "job")} is missing a canonical string \`id\``);
	if (issues.nonStringId) lines.push(`- ${pluralize(issues.nonStringId, "job")} stores \`id\` as a non-string value`);
	if (issues.legacyScheduleString) lines.push(`- ${pluralize(issues.legacyScheduleString, "job")} stores schedule as a bare string`);
	if (issues.legacyScheduleCron) lines.push(`- ${pluralize(issues.legacyScheduleCron, "job")} still uses \`schedule.cron\``);
	if (issues.legacyPayloadKind) lines.push(`- ${pluralize(issues.legacyPayloadKind, "job")} needs payload kind normalization`);
	if (issues.legacyPayloadCodexModel) lines.push(`- ${pluralize(issues.legacyPayloadCodexModel, "job")} still uses legacy \`openai-codex/*\` cron model refs`);
	if (issues.legacyPayloadProvider) lines.push(`- ${pluralize(issues.legacyPayloadProvider, "job")} still uses payload \`provider\` as a delivery alias`);
	if (issues.legacyTopLevelPayloadFields) lines.push(`- ${pluralize(issues.legacyTopLevelPayloadFields, "job")} still uses top-level payload fields`);
	if (issues.legacyTopLevelDeliveryFields) lines.push(`- ${pluralize(issues.legacyTopLevelDeliveryFields, "job")} still uses top-level delivery fields`);
	if (issues.legacyDeliveryMode) lines.push(`- ${pluralize(issues.legacyDeliveryMode, "job")} still uses delivery mode \`deliver\``);
	if (issues.invalidSchedule) lines.push(`- ${pluralize(issues.invalidSchedule, "job")} has an invalid persisted schedule and will be removed`);
	if (issues.invalidPayload) lines.push(`- ${pluralize(issues.invalidPayload, "job")} has an invalid persisted payload and will be removed`);
	return lines;
}
function normalizeModelProvider(value) {
	const raw = normalizeOptionalString(value);
	if (!raw) return;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash >= raw.length - 1) return;
	return raw.slice(0, slash).trim().toLowerCase() || void 0;
}
function normalizeModelRef(value) {
	const raw = normalizeOptionalString(value);
	if (!raw) return;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash >= raw.length - 1) return;
	const provider = raw.slice(0, slash).trim().toLowerCase();
	const model = raw.slice(slash + 1).trim();
	return provider && model ? `${provider}/${model}` : void 0;
}
function normalizeModelMismatchKey(value) {
	return normalizeModelRef(value) ?? normalizeOptionalString(value)?.toLowerCase();
}
function getRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function formatProviderCounts(counts) {
	return [...counts.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([provider, count]) => `${provider}=${count}`).join(", ");
}
function noteCronModelOverrides(params) {
	const defaultModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
	const defaultKey = normalizeModelMismatchKey(defaultModel);
	const providerCounts = /* @__PURE__ */ new Map();
	const mismatchExamples = [];
	let overrideCount = 0;
	let mismatchCount = 0;
	for (const rawJob of params.jobs) {
		const payload = getRecord(rawJob.payload);
		const kind = normalizeOptionalString(payload?.kind)?.toLowerCase();
		if (kind && kind !== "agentturn") continue;
		const model = normalizeOptionalString(payload?.model);
		if (!model) continue;
		overrideCount += 1;
		const provider = normalizeModelProvider(model) ?? "bare/alias";
		providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
		const modelKey = normalizeModelMismatchKey(model);
		if (defaultKey && modelKey && modelKey !== defaultKey) {
			mismatchCount += 1;
			if (mismatchExamples.length < CRON_MODEL_OVERRIDE_EXAMPLE_LIMIT) {
				const id = normalizeOptionalString(rawJob.id) ?? normalizeOptionalString(rawJob.jobId);
				const name = normalizeOptionalString(rawJob.name);
				mismatchExamples.push(`${id ?? name ?? "<unnamed>"} -> ${model}`);
			}
		}
	}
	if (overrideCount === 0) return;
	const lines = [
		`Cron model overrides detected at ${shortenHomePath(params.storePath)}.`,
		`- ${pluralize(overrideCount, "job")} set \`payload.model\` and will not inherit \`agents.defaults.model\`${defaultModel ? ` (${defaultModel})` : ""}`,
		`- Provider namespaces: ${formatProviderCounts(providerCounts)}`
	];
	if (mismatchCount > 0) {
		lines.push(`- ${pluralize(mismatchCount, "job")} ${mismatchCount === 1 ? "uses" : "use"} a different model than \`agents.defaults.model\`${defaultModel ? ` (${defaultModel})` : ""}`);
		lines.push(`- Examples: ${mismatchExamples.join(", ")}`);
	}
	lines.push(`Review with ${formatCliCommand("openclaw cron list")} and ${formatCliCommand("openclaw cron show <job-id>")}; remove \`payload.model\` from jobs that should inherit the default.`);
	note(lines.join("\n"), "Cron");
}
function migrateLegacyNotifyFallback(params) {
	let changed = false;
	const warnings = [];
	for (const raw of params.jobs) {
		if (!("notify" in raw)) continue;
		const jobName = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id) ?? "<unnamed>";
		if (!(raw.notify === true)) {
			delete raw.notify;
			changed = true;
			continue;
		}
		const delivery = raw.delivery && typeof raw.delivery === "object" && !Array.isArray(raw.delivery) ? raw.delivery : null;
		const mode = normalizeOptionalLowercaseString(delivery?.mode);
		const to = normalizeOptionalString(delivery?.to);
		if (mode === "webhook" && to) {
			delete raw.notify;
			changed = true;
			continue;
		}
		if ((mode === void 0 || mode === "none" || mode === "webhook") && params.legacyWebhook) {
			raw.delivery = {
				...delivery,
				mode: "webhook",
				to: mode === "none" ? params.legacyWebhook : to ?? params.legacyWebhook
			};
			delete raw.notify;
			changed = true;
			continue;
		}
		if (!params.legacyWebhook) {
			warnings.push(`Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is unset so doctor cannot migrate it automatically.`);
			continue;
		}
		warnings.push(`Cron job "${jobName}" uses legacy notify fallback alongside delivery mode "${mode}". Migrate it manually so webhook delivery does not replace existing announce behavior.`);
	}
	return {
		changed,
		warnings
	};
}
async function readUserCrontab() {
	const result = await execFileAsync("crontab", ["-l"], {
		encoding: "utf8",
		windowsHide: true
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr
	};
}
function coerceCrontabText(crontab) {
	if (typeof crontab === "string") return crontab;
	if (crontab == null) return "";
	if (typeof crontab === "number" || typeof crontab === "boolean" || typeof crontab === "bigint") return String(crontab);
	return "";
}
function findLegacyWhatsAppHealthCrontabLines(crontab) {
	return coerceCrontabText(crontab).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")).filter((line) => LEGACY_WHATSAPP_HEALTH_SCRIPT_RE.test(line));
}
async function collectLegacyWhatsAppCrontabHealthWarning(params = {}) {
	if ((params.platform ?? process.platform) !== "linux") return null;
	let crontab;
	try {
		crontab = (await (params.readCrontab ?? readUserCrontab)()).stdout;
	} catch {
		return null;
	}
	const legacyLines = findLegacyWhatsAppHealthCrontabLines(crontab);
	if (legacyLines.length === 0) return null;
	return [
		"Legacy WhatsApp crontab health check detected.",
		"`~/.openclaw/bin/ensure-whatsapp.sh` is not maintained by current OpenClaw and can misreport `Gateway inactive` from cron when the systemd user bus environment is missing.",
		`Remove the stale crontab entry with ${formatCliCommand("crontab -e")}; use ${formatCliCommand("openclaw channels status --probe")}, ${formatCliCommand("openclaw doctor")}, and ${formatCliCommand("openclaw gateway status")} for current health checks.`,
		`Matched ${pluralize(legacyLines.length, "entry")}.`
	].join("\n");
}
async function noteLegacyWhatsAppCrontabHealthCheck(params = {}) {
	const warning = await collectLegacyWhatsAppCrontabHealthWarning(params);
	if (warning) note(warning, "Cron");
}
async function maybeRepairLegacyCronStore(params) {
	const storePath = resolveCronStorePath(params.cfg.cron?.store);
	const rawJobs = (await loadCronStore(storePath)).jobs ?? [];
	if (rawJobs.length === 0) return;
	noteCronModelOverrides({
		cfg: params.cfg,
		jobs: rawJobs,
		storePath
	});
	const normalized = normalizeStoredCronJobs(rawJobs);
	const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
	const notifyCount = rawJobs.filter((job) => job.notify === true).length;
	const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
	const previewLines = formatLegacyIssuePreview(normalized.issues);
	if (notifyCount > 0) previewLines.push(`- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`);
	if (dreamingStaleCount > 0) previewLines.push(`- ${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape`);
	if (previewLines.length === 0) return;
	note([
		`Legacy cron job storage detected at ${shortenHomePath(storePath)}.`,
		...previewLines,
		`Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`
	].join("\n"), "Cron");
	if (!await params.prompter.confirm({
		message: "Repair legacy cron jobs now?",
		initialValue: true
	})) return;
	const notifyMigration = migrateLegacyNotifyFallback({
		jobs: rawJobs,
		legacyWebhook
	});
	const dreamingMigration = migrateLegacyDreamingPayloadShape(rawJobs);
	const changed = normalized.mutated || notifyMigration.changed || dreamingMigration.changed;
	if (!changed && notifyMigration.warnings.length === 0) return;
	if (changed) {
		await saveCronStore(storePath, {
			version: 1,
			jobs: rawJobs
		});
		note(`Cron store normalized at ${shortenHomePath(storePath)}.`, "Doctor changes");
		if (dreamingMigration.rewrittenCount > 0) note(`Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`, "Doctor changes");
	}
	if (notifyMigration.warnings.length > 0) note(notifyMigration.warnings.join("\n"), "Doctor warnings");
}
//#endregion
export { collectLegacyWhatsAppCrontabHealthWarning, maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck };
