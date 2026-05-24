//#region src/kernel/autonomy-engine.ts
/** 向 CbrStore 添加一条进化观察记录（无 cbrStore 时静默跳过）。 */
function buildEvolutionRecordAdder(runtime) {
	return (kind, description) => {
		if (!runtime.cbrStore) return;
		try {
			runtime.cbrStore.add(`evolution:${kind}`, description, {
				type: "evolution_observation",
				kind
			});
		} catch {}
	};
}
const _negativeFeedbackCount = /* @__PURE__ */ new Map();
const NEGATIVE_FEEDBACK_THRESHOLD = 3;
/**
* 记录用户反馈到进化数据。
* 负反馈连续累计到 NEGATIVE_FEEDBACK_THRESHOLD 时发布 autonomy.learn_opportunity。
*/
async function recordFeedback(runtime, opts) {
	const addEvolutionRecord = buildEvolutionRecordAdder(runtime);
	const key = opts.intent ?? "unknown";
	if (opts.feedback === "negative") {
		const count = (_negativeFeedbackCount.get(key) ?? 0) + 1;
		_negativeFeedbackCount.set(key, count);
		addEvolutionRecord("feedback", `负反馈：意图 "${key}" 用户输入 "${opts.input.slice(0, 80)}" | note: ${opts.note ?? ""}`);
		if (count >= NEGATIVE_FEEDBACK_THRESHOLD) {
			_negativeFeedbackCount.set(key, 0);
			await runtime.kernel.publish("autonomy.learn_opportunity", "autonomy-engine", {
				signal: "negative_feedback",
				description: `意图 "${key}" 连续收到 ${count} 次负反馈，建议优化对应 Playbook/Scaffold`,
				detected_at: (/* @__PURE__ */ new Date()).toISOString(),
				metadata: {
					intent: key,
					count,
					last_input: opts.input.slice(0, 200)
				}
			});
		}
	} else _negativeFeedbackCount.set(key, 0);
}
/**
* 检测最近事件流中的自主学习机会，并以副作用形式发布对应事件。
*
* 调用方：可在定时任务、Playbook 后处理、或 evolve 闭环中定期触发。
*/
async function detectLearnOpportunities(runtime) {
	const kernel = runtime.kernel;
	const addEvolutionRecord = buildEvolutionRecordAdder(runtime);
	const stubEvents = kernel.getRecentEvents(50, "autonomy.stub_response");
	for (const e of stubEvents) {
		await kernel.publish("autonomy.learn_opportunity", "autonomy-engine", {
			signal: "stub_response",
			description: "检测到未命中 Playbook 的兜底回复",
			detected_at: (/* @__PURE__ */ new Date()).toISOString(),
			metadata: {
				source: e.source,
				ts: e.ts.toISOString()
			}
		});
		addEvolutionRecord("gap", `Stub 响应信号：来源 ${e.source}，时间 ${e.ts.toISOString()}`);
	}
	const KNOWLEDGE_GAP_WINDOW_MS = 1440 * 60 * 1e3;
	const KNOWLEDGE_GAP_THRESHOLD = 5;
	const nowTs = Date.now();
	const recentStubEvents = kernel.getRecentEvents(500, "autonomy.stub_response").filter((e) => {
		return nowTs - (e.ts instanceof Date ? e.ts.getTime() : Number(e.ts)) < KNOWLEDGE_GAP_WINDOW_MS;
	});
	if (recentStubEvents.length >= KNOWLEDGE_GAP_THRESHOLD) {
		const samples = recentStubEvents.slice(0, 3).map((e) => e.type || e.source).filter(Boolean);
		await kernel.publish("autonomy.learn_opportunity", "autonomy-engine", {
			signal: "knowledge_gap",
			description: `过去 24 小时内检测到 ${recentStubEvents.length} 次未解析意图（兜底回复），建议补充对应 Playbook 或知识库`,
			detected_at: (/* @__PURE__ */ new Date()).toISOString(),
			metadata: {
				gap_type: "knowledge_gap",
				count: recentStubEvents.length,
				threshold: KNOWLEDGE_GAP_THRESHOLD,
				sample_inputs: samples
			}
		});
		addEvolutionRecord("gap", `知识缺口：24h 内 ${recentStubEvents.length} 次兜底，样本：${samples.join(" | ")}`);
	}
	const CORRELATION_WINDOW_MS = 300 * 1e3;
	const CORRELATION_THRESHOLD = 3;
	const now = Date.now();
	const windowEvents = kernel.getRecentEvents(200).filter((e) => {
		return now - (e.ts instanceof Date ? e.ts.getTime() : Number(e.ts)) < CORRELATION_WINDOW_MS;
	});
	const typeCount = /* @__PURE__ */ new Map();
	for (const e of windowEvents) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
	for (const [eventType, count] of typeCount.entries()) if (count >= CORRELATION_THRESHOLD && !eventType.startsWith("system.") && !eventType.startsWith("autonomy.")) {
		await kernel.publish("correlation.pattern_detected", "autonomy-engine", {
			event_type: eventType,
			count,
			window_ms: CORRELATION_WINDOW_MS,
			window_minutes: CORRELATION_WINDOW_MS / 6e4,
			detected_at: (/* @__PURE__ */ new Date()).toISOString()
		});
		addEvolutionRecord("pattern", `高频事件模式: ${eventType} 在 ${CORRELATION_WINDOW_MS / 6e4} 分钟内出现 ${count} 次`);
	}
}
//#endregion
export { detectLearnOpportunities, recordFeedback };
