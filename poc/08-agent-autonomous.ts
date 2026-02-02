/**
 * POC 8: Agent 自主分析 — AI 全流程自动完成
 *
 * 演示: Agent 自主组合工具完成 "搜索 → 匹配 → 分析 → 推送" 全流程
 * 运行: bun poc/08-agent-autonomous.ts
 *
 * 展示 Moltbot 的 Agent 如何自主使用工具链完成复杂分析任务
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "data");
const sectors = JSON.parse(readFileSync(join(DATA_DIR, "sectors.json"), "utf-8"));

// ============================================================
// 1. 模拟 Agent 的工具箱
// ============================================================

type ToolCall = { name: string; input: Record<string, unknown> };
type ToolResult = { output: string };

const toolHandlers: Record<string, (input: Record<string, unknown>) => ToolResult> = {
	web_search(input) {
		return {
			output: JSON.stringify([
				{
					title: "国务院发布芯片产业扶持新政策",
					url: "https://news.example.com/1",
					age: "2h",
				},
				{
					title: "英伟达B300发布，AI算力提升3倍",
					url: "https://news.example.com/2",
					age: "5h",
				},
				{
					title: "宁德时代固态电池突破500Wh/kg",
					url: "https://news.example.com/3",
					age: "3h",
				},
			]),
		};
	},

	web_fetch(input) {
		return {
			output:
				"国务院印发关于加快集成电路产业发展的若干意见，明确提出加大对光刻机、刻蚀机等关键半导体设备研发投入，计划五年投入超过5000亿元。",
		};
	},

	memory_search(input) {
		const query = String(input.query);
		const results: string[] = [];
		for (const [name, sector] of Object.entries(sectors) as [string, any][]) {
			const tags = sector.tags as string[];
			if (tags.some((t: string) => query.includes(t)) || query.includes(name)) {
				results.push(`${name}: ${tags.join(", ")} → ${sector.stocks.map((s: any) => s.name).join(", ")}`);
			}
		}
		return { output: results.length > 0 ? results.join("\n") : "无匹配" };
	},

	stock_lookup(input) {
		const code = String(input.query);
		for (const [, sector] of Object.entries(sectors) as [string, any][]) {
			const stock = sector.stocks.find((s: any) => s.code === code);
			if (stock) return { output: `${stock.code} ${stock.name} (${stock.role}) — 板块: ${sector.name}` };
		}
		return { output: `未找到: ${code}` };
	},

	message(input) {
		return { output: `已发送到 ${input.channel}:${input.target}` };
	},
};

function executeTool(call: ToolCall): ToolResult {
	const handler = toolHandlers[call.name];
	if (!handler) return { output: `未知工具: ${call.name}` };
	return handler(call.input);
}

// ============================================================
// 2. 模拟 Agent 思考和执行循环
// ============================================================

type AgentStep = {
	thinking: string;
	toolCall?: ToolCall;
	toolResult?: string;
	reply?: string;
};

function simulateAgentRun(prompt: string): AgentStep[] {
	const steps: AgentStep[] = [];

	// 第 1 轮：搜索最新新闻
	steps.push({
		thinking: "用户想让我分析最新的半导体和AI板块新闻。先搜索一下今天的相关新闻。",
		toolCall: {
			name: "web_search",
			input: { query: "半导体 AI 芯片 最新新闻 2026", count: 5, freshness: "pd" },
		},
	});
	steps[0]!.toolResult = executeTool(steps[0]!.toolCall!).output;

	// 第 2 轮：抓取第一条新闻全文
	steps.push({
		thinking: "找到3条相关新闻。先抓取第一条关于芯片政策的详情。",
		toolCall: {
			name: "web_fetch",
			input: { url: "https://news.example.com/1", extractMode: "markdown" },
		},
	});
	steps[1]!.toolResult = executeTool(steps[1]!.toolCall!).output;

	// 第 3 轮：用记忆系统匹配板块
	steps.push({
		thinking: "新闻提到半导体设备和光刻机。用记忆系统匹配相关板块和个股。",
		toolCall: {
			name: "memory_search",
			input: { query: "半导体 光刻 芯片 设备" },
		},
	});
	steps[2]!.toolResult = executeTool(steps[2]!.toolCall!).output;

	// 第 4 轮：查询具体个股
	steps.push({
		thinking: "匹配到半导体板块。查一下龙头股中芯国际的详情。",
		toolCall: {
			name: "stock_lookup",
			input: { query: "688981" },
		},
	});
	steps[3]!.toolResult = executeTool(steps[3]!.toolCall!).output;

	// 第 5 轮：推送分析结果到 Telegram
	steps.push({
		thinking: "分析完成。整理结果发送到用户的Telegram。",
		toolCall: {
			name: "message",
			input: {
				channel: "telegram",
				target: "user_123456",
				message: `🔴 半导体板块重大利好

**国务院芯片扶持新政策**
五年投入超5000亿，28nm设备国产化率目标70%

**关联个股:**
- 688981 中芯国际（晶圆代工龙头）
- 002371 北方华创（半导体设备龙头）

**影响评估:** 利好，力度超预期
**建议:** 关注半导体ETF和龙头股开盘表现`,
			},
		},
	});
	steps[4]!.toolResult = executeTool(steps[4]!.toolCall!).output;

	// 第 6 轮：生成最终回复
	steps.push({
		thinking: "工具调用都完成了，生成最终的分析总结返回给用户。",
		reply: `今日半导体和AI板块分析完成:

1. **半导体板块 — 强利好**
   国务院发布芯片扶持新政策，五年投入超5000亿
   重点关注: 中芯国际、北方华创

2. **AI算力板块 — 利好**
   英伟达B300发布，国内AI服务器厂商受益
   重点关注: 浪潮信息、中科曙光

3. **新能源板块 — 中性偏好**
   宁德时代固态电池技术突破，但量产需等到2027年

分析结果已发送到你的 Telegram。`,
	});

	return steps;
}

// ============================================================
// 3. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 8: Agent 自主分析 — AI 全流程自动完成        ║");
	console.log("╚══════════════════════════════════════════════════╝");

	const prompt = "分析今天半导体和AI板块的最新新闻，找出受益个股，把结果发到我的Telegram";

	console.log(`\n👤 用户指令: "${prompt}"\n`);
	console.log("━".repeat(60));

	const steps = simulateAgentRun(prompt);

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		console.log(`\n🧠 第 ${i + 1} 轮:`);
		console.log(`   思考: ${step.thinking}`);

		if (step.toolCall) {
			console.log(`\n   🔧 工具调用: ${step.toolCall.name}(${JSON.stringify(step.toolCall.input)})`);
			console.log(`   📦 返回结果: ${step.toolResult!.slice(0, 120)}${step.toolResult!.length > 120 ? "..." : ""}`);
		}

		if (step.reply) {
			console.log(`\n   💬 最终回复:`);
			for (const line of step.reply.split("\n")) {
				console.log(`      ${line}`);
			}
		}

		console.log("   " + "─".repeat(55));
	}

	console.log(`\n${"═".repeat(60)}`);
	console.log(`\n📊 Agent 运行统计:`);
	console.log(`   总轮次: ${steps.length}`);
	console.log(`   工具调用: ${steps.filter((s) => s.toolCall).length} 次`);
	console.log(`   使用工具: ${[...new Set(steps.filter((s) => s.toolCall).map((s) => s.toolCall!.name))].join(", ")}`);

	console.log("\n✅ Agent 自主分析演示完成");
	console.log("\n📌 关键点:");
	console.log("  Agent 自主决定调用哪些工具、调用顺序");
	console.log("  每轮工具结果反馈给 AI，AI 决定下一步");
	console.log("  循环直到 AI 认为任务完成 (stop_reason=end_turn)");
}

main().catch(console.error);
