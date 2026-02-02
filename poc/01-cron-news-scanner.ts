/**
 * POC 1: 定时任务系统 (Cron) — 定时扫描新闻
 *
 * 演示: 使用 Moltbot 的 Cron 调度系统创建定时新闻扫描任务
 * 运行: bun poc/01-cron-news-scanner.ts
 *
 * 这个 POC 展示三种调度模式:
 *   1. cron 表达式 — 工作日早 9 点扫描隔夜新闻
 *   2. 固定间隔    — 每 15 分钟盘中扫描
 *   3. 一次性执行  — 指定时间点执行一次
 */

import type {
	CronSchedule,
	CronPayload,
} from "../src/cron/types.js";

// ============================================================
// 1. 定义调度计划
// ============================================================

/** 工作日早 9:00 (Asia/Shanghai) — 盘前新闻汇总 */
const preMarketSchedule: CronSchedule = {
	kind: "cron",
	expr: "0 9 * * 1-5", // 分 时 日 月 周(1-5=周一到周五)
	tz: "Asia/Shanghai",
};

/** 每 15 分钟 — 盘中实时监控 */
const intradaySchedule: CronSchedule = {
	kind: "every",
	everyMs: 15 * 60 * 1000, // 15 分钟 = 900,000 毫秒
};

/** 一次性 — 今天下午 3:05 执行收盘总结 */
const closingSummarySchedule: CronSchedule = {
	kind: "at",
	atMs: getNextClosingTime(),
};

function getNextClosingTime(): number {
	const now = new Date();
	const closing = new Date(now);
	closing.setHours(15, 5, 0, 0);
	if (closing <= now) closing.setDate(closing.getDate() + 1);
	return closing.getTime();
}

// ============================================================
// 2. 定义任务载荷
// ============================================================

/** 让 Agent 执行新闻扫描 */
const premarketPayload: CronPayload = {
	kind: "agentTurn",
	message: `你是一个股票分析助手。请执行以下任务:
1. 搜索过去 12 小时的重大财经新闻
2. 按板块分类: 半导体、新能源、AI人工智能、消费白酒、医药生物
3. 对每条新闻评估影响方向(利好/利空)和影响程度(高/中/低)
4. 把结果发送到我的 Telegram`,
	deliver: true,
};

const intradayPayload: CronPayload = {
	kind: "agentTurn",
	message: `快速扫描最近 15 分钟的突发财经新闻。
只关注可能导致板块异动的重大事件。
如果发现重要新闻，立即通知我。
如果没有重要新闻，回复"盘中无异动"即可。`,
};

const closingPayload: CronPayload = {
	kind: "agentTurn",
	message: `今日收盘总结:
1. 汇总今天所有已分析的新闻和事件
2. 评估各板块当日表现
3. 给出明日需要重点关注的方向
4. 生成一份简洁的每日投资备忘录`,
};

// ============================================================
// 3. 组装完整的 Cron Job 配置
// ============================================================

const cronJobs = [
	{
		name: "盘前新闻扫描",
		description: "工作日早 9:00 扫描隔夜财经新闻，按板块分类并评估影响",
		enabled: true,
		schedule: preMarketSchedule,
		sessionTarget: "isolated" as const,
		wakeMode: "now" as const,
		payload: premarketPayload,
		isolation: {
			postToMainPrefix: "📰 盘前新闻汇总",
			postToMainMode: "summary" as const,
			postToMainMaxChars: 2000,
		},
	},
	{
		name: "盘中快速扫描",
		description: "每 15 分钟扫描突发新闻，发现异动立即通知",
		enabled: true,
		schedule: intradaySchedule,
		sessionTarget: "isolated" as const,
		wakeMode: "now" as const,
		payload: intradayPayload,
	},
	{
		name: "收盘每日总结",
		description: "收盘后生成当日投资备忘录",
		enabled: true,
		schedule: closingSummarySchedule,
		sessionTarget: "main" as const,
		wakeMode: "now" as const,
		payload: closingPayload,
	},
];

// ============================================================
// 4. 模拟 Cron 调度器执行
// ============================================================

function shouldFireNow(schedule: CronSchedule): boolean {
	const now = Date.now();
	if (schedule.kind === "at") return now >= schedule.atMs;
	if (schedule.kind === "every") return true; // 间隔到就执行
	if (schedule.kind === "cron") {
		// 简化版 cron 匹配：检查当前是否为工作日 9:00
		const d = new Date();
		const [min, hour, , , dow] = schedule.expr.split(" ");
		const dayMatch =
			dow === "*" || dow!.includes(String(d.getDay() === 0 ? 7 : d.getDay()));
		const hourMatch = hour === "*" || Number(hour) === d.getHours();
		const minMatch = min === "*" || Number(min) === d.getMinutes();
		return dayMatch && hourMatch && minMatch;
	}
	return false;
}

async function simulateCronTick(job: (typeof cronJobs)[0]) {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`⏰ 任务: ${job.name}`);
	console.log(`   描述: ${job.description}`);
	console.log(`   调度: ${JSON.stringify(job.schedule)}`);
	console.log(`   启用: ${job.enabled}`);
	console.log(`   会话: ${job.sessionTarget}`);

	if (!job.enabled) {
		console.log("   ⏭  任务已禁用，跳过");
		return;
	}

	const willFire = shouldFireNow(job.schedule);
	console.log(`   触发: ${willFire ? "✅ 是" : "⏳ 未到时间"}`);

	if (job.payload.kind === "agentTurn") {
		console.log(`\n   📋 Agent 将收到的指令:`);
		console.log(
			`   ${job.payload.message.split("\n").join("\n   ")}`,
		);
	}

	if (job.isolation) {
		console.log(`\n   📦 隔离配置:`);
		console.log(`      前缀: ${job.isolation.postToMainPrefix}`);
		console.log(`      模式: ${job.isolation.postToMainMode}`);
		console.log(`      最大字符: ${job.isolation.postToMainMaxChars}`);
	}
}

// ============================================================
// 5. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════╗");
	console.log("║  POC 1: Cron 定时任务 — 股票新闻定时扫描     ║");
	console.log("╚══════════════════════════════════════════════╝");
	console.log(`\n当前时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
	console.log(`已配置 ${cronJobs.length} 个定时任务:\n`);

	for (const job of cronJobs) {
		await simulateCronTick(job);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("✅ Cron 配置验证完成");
	console.log("\n实际运行时，Moltbot 的 CronService 会:");
	console.log("  1. 在后台持续运行调度器");
	console.log("  2. 到达触发时间时自动唤醒 Agent");
	console.log("  3. Agent 执行 web_search/web_fetch 抓取新闻");
	console.log("  4. 分析结果通过 message 工具推送到指定渠道");
}

main().catch(console.error);
