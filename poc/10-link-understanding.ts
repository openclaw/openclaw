/**
 * POC 10: 链接理解 (Link Understanding) — 自动提取新闻要点
 *
 * 演示: 收到新闻链接 → 抓取 → 提取结构化信息 → 匹配板块
 * 运行: bun poc/10-link-understanding.ts
 *
 * 展示 Moltbot 的 Link Understanding 如何自动从 URL 提取投资相关信息
 */

// ============================================================
// 1. 链接检测（对应 src/link-understanding/detect.ts）
// ============================================================

function extractLinksFromMessage(text: string): string[] {
	const urlRegex = /https?:\/\/[^\s<>)"']+/g;
	return [...text.matchAll(urlRegex)].map((m) => m[0]);
}

// ============================================================
// 2. 链接抓取与解析（对应 src/link-understanding/runner.ts）
// ============================================================

type LinkAnalysis = {
	url: string;
	title: string;
	source: string;
	publishTime: string;
	summary: string;
	keyPoints: string[];
	entities: Array<{ type: "company" | "sector" | "metric"; value: string }>;
	sentiment: "positive" | "negative" | "neutral";
	relevantSectors: string[];
};

/** 模拟链接理解（实际由 Moltbot 的 LLM + web_fetch 完成） */
function analyzeLink(url: string): LinkAnalysis {
	const mockAnalyses: Record<string, LinkAnalysis> = {
		"https://finance.sina.com.cn/stock/semiconductor-policy-2026": {
			url,
			title: "国务院发布芯片产业扶持新政策",
			source: "新浪财经",
			publishTime: "2026-02-02 09:00",
			summary: "国务院印发关于加快集成电路产业发展的若干意见，五年投入超5000亿，目标28nm设备国产化率70%。",
			keyPoints: [
				"五年投入超过 5000 亿元",
				"28nm 及以上制程设备国产化率目标 70%",
				"集成电路企业所得税减免延长至 2030 年",
				"新增 10 所集成电路相关学科建设高校",
			],
			entities: [
				{ type: "sector", value: "半导体" },
				{ type: "sector", value: "集成电路" },
				{ type: "company", value: "中芯国际" },
				{ type: "company", value: "北方华创" },
				{ type: "metric", value: "5000亿投入" },
				{ type: "metric", value: "国产化率70%" },
			],
			sentiment: "positive",
			relevantSectors: ["半导体", "AI人工智能"],
		},
		"https://finance.eastmoney.com/catl-solid-state-battery": {
			url,
			title: "宁德时代发布第二代全固态电池",
			source: "东方财富",
			publishTime: "2026-02-02 10:30",
			summary: "宁德时代在全球电池日发布第二代全固态电池，能量密度500Wh/kg，预计2027年量产。",
			keyPoints: [
				"能量密度达到 500Wh/kg，较上代提升 40%",
				"预计 2027 年实现量产",
				"首批客户: 蔚来、宝马",
				"成本较液态电池仍高 30%",
			],
			entities: [
				{ type: "sector", value: "新能源" },
				{ type: "sector", value: "锂电" },
				{ type: "company", value: "宁德时代" },
				{ type: "company", value: "蔚来" },
				{ type: "metric", value: "500Wh/kg" },
				{ type: "metric", value: "2027年量产" },
			],
			sentiment: "positive",
			relevantSectors: ["新能源"],
		},
		"https://reuters.com/nvidia-b300-launch": {
			url,
			title: "NVIDIA launches B300 GPU with 3x AI performance",
			source: "Reuters",
			publishTime: "2026-02-02 08:00",
			summary: "英伟达在GTC大会发布B300 GPU，AI训练算力较H100提升3倍，中国合规版Q2上市。",
			keyPoints: [
				"单卡 AI 训练性能较 H100 提升 3 倍",
				"每瓦算力提升 2.5 倍",
				"中国合规版 Q2 上市",
				"多家国内 AI 服务器厂商获首批订单",
			],
			entities: [
				{ type: "sector", value: "AI人工智能" },
				{ type: "sector", value: "半导体" },
				{ type: "company", value: "英伟达" },
				{ type: "company", value: "浪潮信息" },
				{ type: "company", value: "中科曙光" },
				{ type: "metric", value: "算力提升3倍" },
			],
			sentiment: "positive",
			relevantSectors: ["AI人工智能", "半导体"],
		},
	};

	return (
		mockAnalyses[url] ?? {
			url,
			title: "未知页面",
			source: "unknown",
			publishTime: "",
			summary: "无法解析",
			keyPoints: [],
			entities: [],
			sentiment: "neutral" as const,
			relevantSectors: [],
		}
	);
}

// ============================================================
// 3. 格式化输出（对应 src/link-understanding/format.ts）
// ============================================================

function formatAnalysis(analysis: LinkAnalysis): string {
	const sentimentEmoji = { positive: "📈", negative: "📉", neutral: "➡️" }[analysis.sentiment];
	const sentimentLabel = { positive: "利好", negative: "利空", neutral: "中性" }[analysis.sentiment];

	const lines = [
		`${sentimentEmoji} **${analysis.title}**`,
		`来源: ${analysis.source} | ${analysis.publishTime}`,
		"",
		`> ${analysis.summary}`,
		"",
		"**要点:**",
		...analysis.keyPoints.map((p) => `  - ${p}`),
		"",
		"**识别实体:**",
		...analysis.entities.map((e) => {
			const icon = { company: "🏢", sector: "📊", metric: "📐" }[e.type];
			return `  ${icon} [${e.type}] ${e.value}`;
		}),
		"",
		`**情感: ${sentimentLabel}** | 关联板块: ${analysis.relevantSectors.join(", ")}`,
	];

	return lines.join("\n");
}

// ============================================================
// 4. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 10: Link Understanding — 自动提取新闻要点   ║");
	console.log("╚══════════════════════════════════════════════════╝");

	// 场景: 用户发来一段包含多个链接的消息
	const userMessage = `今天几条重要新闻，帮我分析一下:
https://finance.sina.com.cn/stock/semiconductor-policy-2026
https://finance.eastmoney.com/catl-solid-state-battery
https://reuters.com/nvidia-b300-launch`;

	console.log("\n👤 用户消息:");
	console.log(`  ${userMessage.replace(/\n/g, "\n  ")}\n`);

	// Step 1: 提取链接
	const links = extractLinksFromMessage(userMessage);
	console.log(`🔗 检测到 ${links.length} 个链接:\n`);
	for (const link of links) {
		console.log(`  - ${link}`);
	}

	// Step 2: 逐个分析
	const analyses: LinkAnalysis[] = [];
	for (const link of links) {
		console.log(`\n${"─".repeat(60)}`);
		console.log(`📡 分析: ${link}\n`);

		const analysis = analyzeLink(link);
		analyses.push(analysis);

		console.log(formatAnalysis(analysis));
	}

	// Step 3: 汇总
	console.log(`\n${"═".repeat(60)}`);
	console.log("\n📋 汇总分析:\n");

	const allSectors = [...new Set(analyses.flatMap((a) => a.relevantSectors))];
	const allCompanies = [
		...new Set(analyses.flatMap((a) => a.entities.filter((e) => e.type === "company").map((e) => e.value))),
	];

	console.log(`  涉及板块: ${allSectors.join(", ")}`);
	console.log(`  涉及公司: ${allCompanies.join(", ")}`);
	console.log(`  情感分布:`);
	for (const s of ["positive", "negative", "neutral"] as const) {
		const count = analyses.filter((a) => a.sentiment === s).length;
		if (count > 0) {
			const label = { positive: "利好", negative: "利空", neutral: "中性" }[s];
			console.log(`    ${label}: ${count} 条`);
		}
	}

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ Link Understanding 演示完成");
	console.log("\n📌 Moltbot 的 Link Understanding:");
	console.log("  - 自动检测消息中的 URL");
	console.log("  - 抓取页面并用 AI 提取结构化信息");
	console.log("  - 识别公司、板块、关键指标");
	console.log("  - 评估情感倾向（利好/利空/中性）");
	console.log("  - 结果可直接接入板块匹配系统");
}

main().catch(console.error);
