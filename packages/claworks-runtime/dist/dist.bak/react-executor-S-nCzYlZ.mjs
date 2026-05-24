//#region src/agents/react-executor.ts
/** 能力前缀黑名单（安全保护）*/
const BLOCKED_PREFIXES = [
	"security.",
	"governance.",
	"evolve.deploy",
	"evolve.remove"
];
function isSafeCapability(capId) {
	return !BLOCKED_PREFIXES.some((p) => capId.startsWith(p));
}
function extractJson(text) {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		return JSON.parse(m[0]);
	} catch {
		return null;
	}
}
async function runReact(goal, tools, maxIterations, runtime, ctx) {
	const kernel = runtime.kernel;
	const registered = kernel.listCapabilities?.().map((c) => c.id) ?? [];
	const safeTools = (tools.length > 0 ? tools : registered).filter((t) => registered.includes(t) && isSafeCapability(t));
	const iterations = [];
	let done = false;
	let conclusion = "";
	const llm = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
	for (let i = 0; i < maxIterations && !done; i++) {
		const history = iterations.length > 0 ? iterations.map((it) => `迭代${it.iteration}→思考:${it.thought}→执行:${it.action.capability}→结果:${JSON.stringify(it.observation).slice(0, 150)}`).join("\n") : "（无）";
		const prompt = `目标：${goal}\n可用工具：${safeTools.join(", ") || "（无）"}\n历史：${history}\n\n请决定下一步，返回JSON：{"thought":"思考","action":{"capability":"能力ID","params":{}},"done":false,"conclusion":"若完成则填写"}`;
		let decision;
		try {
			if (!llm) throw new Error("LLM 未配置");
			const parsed = extractJson((await llm({ prompt })).text);
			if (parsed && typeof parsed === "object") decision = parsed;
			else decision = {
				thought: "JSON 解析失败",
				action: {
					capability: safeTools[0] ?? "",
					params: {}
				},
				done: true,
				conclusion: "LLM 返回格式错误，执行终止"
			};
		} catch (e) {
			decision = {
				thought: `LLM 调用失败: ${e instanceof Error ? e.message : String(e)}`,
				action: {
					capability: "",
					params: {}
				},
				done: true,
				conclusion: "执行失败"
			};
		}
		const capId = decision.action?.capability ?? "";
		let observation;
		try {
			if (capId && safeTools.includes(capId) && kernel.callCapability) observation = await kernel.callCapability(capId, ctx, decision.action?.params ?? {});
			else if (capId) observation = { error: `工具 ${capId} 不在安全白名单中` };
			else observation = {
				skipped: true,
				reason: "未指定工具"
			};
		} catch (e) {
			observation = { error: e instanceof Error ? e.message : String(e) };
		}
		const iter = {
			iteration: i + 1,
			thought: decision.thought ?? "",
			action: {
				capability: capId,
				params: decision.action?.params ?? {}
			},
			observation,
			done: !!decision.done,
			conclusion: decision.conclusion
		};
		iterations.push(iter);
		if (decision.done) {
			done = true;
			conclusion = decision.conclusion ?? "";
		}
	}
	return {
		goal,
		iterations,
		conclusion: conclusion || `完成 ${iterations.length} 次迭代`,
		success: done
	};
}
//#endregion
export { runReact };
