/**
 * POC 7: 钩子系统 (Hooks) — 事件驱动自动化
 *
 * 演示: 消息到达 → 触发钩子 → 自动分析 → 记录/通知
 * 运行: bun poc/07-hooks-event-driven.ts
 *
 * 展示 Moltbot 的 Hooks 如何实现事件驱动的投资分析自动化
 */

// ============================================================
// 1. 事件系统模拟（对应 src/hooks/internal-hooks.ts）
// ============================================================

type HookEventType = "inbound" | "command" | "agent" | "session" | "cron";

type HookEvent = {
	type: HookEventType;
	action: string;
	sessionKey: string;
	context: Record<string, unknown>;
	timestamp: Date;
	messages: string[];
};

type HookHandler = (event: HookEvent) => Promise<void>;

/** 简易事件总线 */
class EventBus {
	private handlers = new Map<string, HookHandler[]>();

	register(eventKey: string, handler: HookHandler) {
		const list = this.handlers.get(eventKey) ?? [];
		list.push(handler);
		this.handlers.set(eventKey, list);
		console.log(`  📎 注册钩子: ${eventKey}`);
	}

	async emit(event: HookEvent) {
		const key = `${event.type}:${event.action}`;
		const handlers = this.handlers.get(key) ?? [];
		const wildcardHandlers = this.handlers.get(`${event.type}:*`) ?? [];

		console.log(`\n  🔔 事件触发: ${key} (${handlers.length + wildcardHandlers.length} 个处理器)`);

		for (const handler of [...handlers, ...wildcardHandlers]) {
			await handler(event);
		}
	}
}

const bus = new EventBus();

// ============================================================
// 2. 定义股票分析相关的钩子
// ============================================================

/** 钩子 1: 新闻消息到达时自动分析 */
bus.register("inbound:message", async (event) => {
	const text = String(event.context.text ?? "");
	const source = String(event.context.source ?? "unknown");

	// 检测是否为财经新闻源
	const newsKeywords = ["半导体", "芯片", "新能源", "锂电", "白酒", "茅台", "创新药", "AI", "算力"];
	const matched = newsKeywords.filter((kw) => text.includes(kw));

	if (matched.length === 0) {
		console.log(`    ⏭  非财经相关消息，跳过`);
		return;
	}

	console.log(`    🎯 检测到财经新闻！命中关键词: ${matched.join(", ")}`);
	console.log(`    📝 来源: ${source}`);
	console.log(`    📊 触发自动分析流程...`);
	console.log(`    → 调用 memory_search 匹配板块`);
	console.log(`    → 调用 Agent 分析影响`);
	console.log(`    → 推送结果到 Telegram`);
});

/** 钩子 2: Agent 分析完成后保存到记忆系统 */
bus.register("agent:end", async (event) => {
	const result = event.context.result as string | undefined;
	if (!result) return;

	const filename = `analysis-${new Date().toISOString().slice(0, 10)}-${Date.now()}.md`;
	console.log(`    💾 保存分析结果到记忆: memory/${filename}`);
	console.log(`    → 内容长度: ${result.length} 字符`);
	console.log(`    → 自动向量索引，下次可语义搜索`);
});

/** 钩子 3: 定时任务完成后汇总 */
bus.register("cron:complete", async (event) => {
	const jobName = String(event.context.jobName ?? "unknown");
	const resultCount = Number(event.context.resultCount ?? 0);

	console.log(`    ⏰ 定时任务 "${jobName}" 完成`);
	console.log(`    → 发现 ${resultCount} 条相关新闻`);
	if (resultCount > 0) {
		console.log(`    → 触发汇总推送...`);
	}
});

/** 钩子 4: 新会话开始时加载上次分析上下文 */
bus.register("session:start", async (event) => {
	console.log(`    📂 新会话开始，加载历史上下文`);
	console.log(`    → 搜索最近 3 天的分析记录`);
	console.log(`    → 注入到系统提示词中`);
});

/** 钩子 5: 命令钩子 — /stock 快捷命令 */
bus.register("command:stock", async (event) => {
	const ticker = String(event.context.args ?? "");
	console.log(`    📈 快捷查询: /stock ${ticker}`);
	console.log(`    → 调用 stock_lookup 工具`);
	console.log(`    → 返回实时行情 + 板块信息`);
});

// ============================================================
// 3. 模拟事件流
// ============================================================

async function simulateEventFlow() {
	// 事件 1: 一条普通消息（不触发分析）
	console.log("\n━━━ 事件 1: 普通消息 ━━━");
	await bus.emit({
		type: "inbound",
		action: "message",
		sessionKey: "telegram:user:123",
		context: { text: "今天天气不错", source: "user" },
		timestamp: new Date(),
		messages: [],
	});

	// 事件 2: 一条财经新闻（触发自动分析）
	console.log("\n━━━ 事件 2: 财经新闻到达 ━━━");
	await bus.emit({
		type: "inbound",
		action: "message",
		sessionKey: "telegram:news_channel",
		context: {
			text: "国务院发布芯片产业扶持新政策，加大对光刻机等半导体设备研发投入",
			source: "财经新闻频道",
		},
		timestamp: new Date(),
		messages: [],
	});

	// 事件 3: Agent 分析完成
	console.log("\n━━━ 事件 3: Agent 分析完成 ━━━");
	await bus.emit({
		type: "agent",
		action: "end",
		sessionKey: "stock-bot:main",
		context: {
			result:
				"半导体板块利好分析: 国务院政策力度超预期，建议关注中芯国际(688981)、北方华创(002371)...",
		},
		timestamp: new Date(),
		messages: [],
	});

	// 事件 4: 定时任务完成
	console.log("\n━━━ 事件 4: 定时扫描完成 ━━━");
	await bus.emit({
		type: "cron",
		action: "complete",
		sessionKey: "stock-bot:isolated",
		context: { jobName: "盘前新闻扫描", resultCount: 3 },
		timestamp: new Date(),
		messages: [],
	});

	// 事件 5: 新会话开始
	console.log("\n━━━ 事件 5: 新会话开始 ━━━");
	await bus.emit({
		type: "session",
		action: "start",
		sessionKey: "stock-bot:main",
		context: {},
		timestamp: new Date(),
		messages: [],
	});

	// 事件 6: /stock 命令
	console.log("\n━━━ 事件 6: /stock 命令 ━━━");
	await bus.emit({
		type: "command",
		action: "stock",
		sessionKey: "telegram:user:123",
		context: { args: "600519" },
		timestamp: new Date(),
		messages: [],
	});
}

// ============================================================
// 4. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 7: Hooks 钩子 — 事件驱动自动化              ║");
	console.log("╚══════════════════════════════════════════════════╝");

	console.log("\n📎 注册钩子:\n");
	// hooks already registered above

	console.log("\n\n🎬 模拟事件流:");
	await simulateEventFlow();

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 事件驱动演示完成");
	console.log("\n📌 Moltbot Hooks 支持的事件:");
	console.log("  inbound:message  — 消息到达");
	console.log("  agent:start      — Agent 开始运行");
	console.log("  agent:end        — Agent 运行结束");
	console.log("  session:start    — 新会话开始");
	console.log("  command:*        — 命令执行");
	console.log("  cron:complete    — 定时任务完成");
}

main().catch(console.error);
