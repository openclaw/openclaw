/**
 * POC 0: 完整管线 — 事件驱动投资全流程演示
 *
 * 演示: 新闻到达 → 语义匹配板块 → AI 分析 → 多渠道推送
 * 运行: bun poc/00-full-pipeline.ts
 *
 * 这个 POC 把前面 10 个功能串联成一个完整的事件驱动投资分析管线
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "data");

// ============================================================
// 模块加载
// ============================================================

type Stock = { code: string; name: string; role: string };
type Sector = { name: string; tags: string[]; stocks: Stock[] };

const sectors: Record<string, Sector> = JSON.parse(
	readFileSync(join(DATA_DIR, "sectors.json"), "utf-8"),
);
const newsSamples = JSON.parse(
	readFileSync(join(DATA_DIR, "news-samples.json"), "utf-8"),
) as Array<{ id: string; title: string; source: string; time: string; summary: string }>;

// ============================================================
// Step 1: 新闻采集 (Cron + Web Search)
// ============================================================

function step1_collectNews() {
	console.log("\n┌─── Step 1: 新闻采集 (Cron 触发 → Web Search) ───┐");
	console.log("│  ⏰ 定时任务触发: 盘前新闻扫描                      │");
	console.log("│  🔍 web_search('财经 重大新闻', freshness='pd')      │");
	console.log(`│  📰 获取 ${newsSamples.length} 条新闻                                   │`);
	console.log("└──────────────────────────────────────────────────┘");

	for (const news of newsSamples) {
		console.log(`  [${news.time.slice(11, 16)}] ${news.title}`);
	}

	return newsSamples;
}

// ============================================================
// Step 2: 语义匹配 (Memory/RAG)
// ============================================================

type MatchedNews = {
	news: (typeof newsSamples)[0];
	matchedSectors: Array<{
		name: string;
		score: number;
		matchedTags: string[];
		stocks: Stock[];
	}>;
};

function step2_matchSectors(
	newsList: typeof newsSamples,
): MatchedNews[] {
	console.log("\n┌─── Step 2: 语义匹配 (Memory Search → 板块定位) ──┐");
	console.log("│  🧠 memory_search(新闻文本) → 匹配板块和标签         │");
	console.log("└──────────────────────────────────────────────────┘");

	const results: MatchedNews[] = [];

	for (const news of newsList) {
		const fullText = `${news.title} ${news.summary}`;
		const matched: MatchedNews["matchedSectors"] = [];

		for (const [sectorName, sector] of Object.entries(sectors)) {
			const hitTags = sector.tags.filter((tag) => fullText.includes(tag));
			const hitStocks = sector.stocks.filter((s) => fullText.includes(s.name));

			if (hitTags.length > 0 || hitStocks.length > 0) {
				matched.push({
					name: sectorName,
					score: hitTags.length * 0.3 + hitStocks.length * 0.5,
					matchedTags: hitTags,
					stocks: sector.stocks,
				});
			}
		}

		matched.sort((a, b) => b.score - a.score);

		const arrow = matched.length > 0 ? "🎯" : "⏭ ";
		const sectorNames = matched.map((m) => m.name).join(", ") || "无匹配";
		console.log(`  ${arrow} ${news.title.slice(0, 35)}... → ${sectorNames}`);

		if (matched.length > 0) {
			results.push({ news, matchedSectors: matched });
		}
	}

	console.log(`\n  📊 匹配结果: ${results.length}/${newsList.length} 条新闻命中板块`);
	return results;
}

// ============================================================
// Step 3: AI 深度分析 (Agent)
// ============================================================

type AnalysisResult = {
	news: (typeof newsSamples)[0];
	sector: string;
	direction: "bullish" | "bearish" | "neutral";
	impact: "high" | "medium" | "low";
	analysis: string;
	topStocks: Array<{ stock: Stock; reason: string }>;
};

function step3_aiAnalysis(matchedNews: MatchedNews[]): AnalysisResult[] {
	console.log("\n┌─── Step 3: AI 深度分析 (Agent 自主推理) ──────────┐");
	console.log("│  🤖 Agent 对每条匹配新闻进行影响分析                │");
	console.log("│  📋 评估: 方向(利好/利空) + 力度(高/中/低)          │");
	console.log("└──────────────────────────────────────────────────┘");

	// 模拟 AI 分析结果
	const analysisMap: Record<string, Partial<AnalysisResult>> = {
		"news-001": {
			direction: "bullish",
			impact: "high",
			analysis: "政策力度超预期，五年5000亿投入+税收减免，半导体板块迎来重大催化。设备和代工环节直接受益。",
			topStocks: [
				{ stock: sectors["半导体"]!.stocks[0]!, reason: "晶圆代工直接受益政策扶持" },
				{ stock: sectors["半导体"]!.stocks[1]!, reason: "半导体设备国产替代核心标的" },
			],
		},
		"news-002": {
			direction: "bullish",
			impact: "medium",
			analysis: "固态电池技术突破，但2027年才量产。短期情绪利好，中期需关注量产进度。",
			topStocks: [
				{ stock: sectors["新能源"]!.stocks[0]!, reason: "技术领先者，直接受益" },
			],
		},
		"news-003": {
			direction: "bullish",
			impact: "high",
			analysis: "B300算力提升3倍，中国合规版Q2上市。国内AI服务器厂商获首批订单，算力产业链全面受益。",
			topStocks: [
				{ stock: sectors["AI人工智能"]!.stocks[1]!, reason: "AI服务器龙头，获首批B300订单" },
				{ stock: sectors["AI人工智能"]!.stocks[2]!, reason: "算力基础设施核心供应商" },
			],
		},
		"news-004": {
			direction: "bullish",
			impact: "medium",
			analysis: "茅台时隔三年首次提价5%，释放积极信号。白酒板块估值修复逻辑增强。",
			topStocks: [
				{ stock: sectors["消费白酒"]!.stocks[0]!, reason: "直接受益提价，龙头地位稳固" },
			],
		},
		"news-005": {
			direction: "bullish",
			impact: "medium",
			analysis: "FDA突破性疗法认定是重要里程碑，标志国产创新药出海进入新阶段。",
			topStocks: [
				{ stock: sectors["医药生物"]!.stocks[0]!, reason: "创新药出海标杆企业" },
			],
		},
	};

	const results: AnalysisResult[] = [];

	for (const mn of matchedNews) {
		const mockResult = analysisMap[mn.news.id];
		if (!mockResult) continue;

		const result: AnalysisResult = {
			news: mn.news,
			sector: mn.matchedSectors[0]!.name,
			direction: mockResult.direction!,
			impact: mockResult.impact!,
			analysis: mockResult.analysis!,
			topStocks: mockResult.topStocks!,
		};

		const dirIcon = result.direction === "bullish" ? "📈" : result.direction === "bearish" ? "📉" : "➡️";
		const impactIcon = { high: "🔴", medium: "🟡", low: "🟢" }[result.impact];
		console.log(`  ${dirIcon}${impactIcon} [${result.sector}] ${result.news.title.slice(0, 40)}...`);
		console.log(`     ${result.analysis.slice(0, 60)}...`);

		results.push(result);
	}

	return results;
}

// ============================================================
// Step 4: 多渠道推送 (Message Tool)
// ============================================================

function step4_pushNotifications(analyses: AnalysisResult[]) {
	console.log("\n┌─── Step 4: 多渠道推送 (Message Tool) ─────────────┐");
	console.log("│  📤 推送到 Telegram / Discord / Slack               │");
	console.log("└──────────────────────────────────────────────────┘");

	// 按影响力排序
	const sorted = [...analyses].sort((a, b) => {
		const order = { high: 0, medium: 1, low: 2 };
		return order[a.impact] - order[b.impact];
	});

	// 生成推送消息
	const lines = ["📊 **今日盘前新闻分析**\n"];

	for (const a of sorted) {
		const dirIcon = a.direction === "bullish" ? "📈" : "📉";
		const impactLabel = { high: "强", medium: "中", low: "弱" }[a.impact];

		lines.push(`${dirIcon} **${a.sector}** (${impactLabel})`);
		lines.push(`  ${a.news.title}`);
		lines.push(`  ${a.analysis}`);
		lines.push(`  关注: ${a.topStocks.map((s) => s.stock.name).join(", ")}`);
		lines.push("");
	}

	const message = lines.join("\n");

	console.log("\n  生成的推送消息:");
	console.log("  ┌────────────────────────────────────────┐");
	for (const line of message.split("\n")) {
		console.log(`  │ ${line.padEnd(40)}│`);
	}
	console.log("  └────────────────────────────────────────┘");

	console.log("\n  📤 发送到:");
	console.log('    → Telegram (user_123456)      ✅ 已发送 + 行内按钮');
	console.log('    → Discord (#stock-alerts)     ✅ 已发送');
	console.log('    → Slack (#investment)         ✅ 已发送');
}

// ============================================================
// Step 5: 保存到记忆系统 (Session + Memory)
// ============================================================

function step5_saveToMemory(analyses: AnalysisResult[]) {
	console.log("\n┌─── Step 5: 持久化 (Session + Memory) ─────────────┐");
	console.log("│  💾 保存分析会话 + 索引到向量记忆                    │");
	console.log("└──────────────────────────────────────────────────┘");

	const date = new Date().toISOString().slice(0, 10);
	console.log(`  📝 会话保存: sessions/stock-analysis-${date}.jsonl`);
	console.log(`     → ${analyses.length} 条分析记录`);
	console.log(`  🧠 记忆索引: memory/daily/${date}.md`);
	console.log("     → 自动生成向量嵌入");
	console.log("     → 下次分析可语义搜索历史记录");
}

// ============================================================
// 主流程
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════════╗");
	console.log("║  POC 0: 完整管线 — 事件驱动投资分析全流程             ║");
	console.log("╠══════════════════════════════════════════════════════╣");
	console.log("║  新闻采集 → 语义匹配 → AI分析 → 推送 → 持久化       ║");
	console.log("╚══════════════════════════════════════════════════════╝");

	const news = step1_collectNews();
	const matched = step2_matchSectors(news);
	const analyses = step3_aiAnalysis(matched);
	step4_pushNotifications(analyses);
	step5_saveToMemory(analyses);

	console.log(`\n${"═".repeat(55)}`);
	console.log("\n✅ 完整管线演示完成\n");
	console.log("管线统计:");
	console.log(`  新闻采集:   ${news.length} 条`);
	console.log(`  板块匹配:   ${matched.length} 条命中`);
	console.log(`  AI 分析:    ${analyses.length} 条报告`);
	console.log(`  推送渠道:   3 个 (Telegram/Discord/Slack)`);
	console.log(`  持久化:     Session + Memory 双写`);
	console.log("\n对应 Moltbot 功能:");
	console.log("  Step 1 → Cron + web_search");
	console.log("  Step 2 → Memory (RAG 向量搜索)");
	console.log("  Step 3 → Agent (pi-embedded-runner)");
	console.log("  Step 4 → message 工具 (多渠道)");
	console.log("  Step 5 → Session + Memory 持久化");
}

main().catch(console.error);
