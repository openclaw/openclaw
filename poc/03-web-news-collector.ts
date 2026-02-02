/**
 * POC 3: 网页抓取 (Web Search + Fetch) — 新闻采集
 *
 * 演示: 搜索财经新闻 → 抓取全文 → 提取关键信息
 * 运行: bun poc/03-web-news-collector.ts
 *
 * 展示 Moltbot 的 web_search 和 web_fetch 工具如何用于新闻采集
 */

// ============================================================
// 1. Web Search — 搜索新闻（模拟 Moltbot web_search 工具）
// ============================================================

type SearchResult = {
	title: string;
	url: string;
	description: string;
	age: string;
};

/**
 * 模拟 Moltbot 的 web_search 工具
 *
 * 实际调用时等价于:
 *   Agent 使用 web_search({ query: "...", count: 5, freshness: "pd" })
 *   底层调用 Brave Search API 或 Perplexity
 */
function simulateWebSearch(params: {
	query: string;
	count?: number;
	freshness?: string;
}): SearchResult[] {
	console.log(`  🔍 web_search(query="${params.query}", freshness="${params.freshness ?? "all"}")`);

	// 模拟搜索结果
	const mockResults: Record<string, SearchResult[]> = {
		半导体: [
			{
				title: "国务院发布芯片产业扶持新政策",
				url: "https://news.example.com/semiconductor-policy",
				description: "加大对光刻机、刻蚀机等关键半导体设备的研发投入...",
				age: "2h",
			},
			{
				title: "中芯国际Q4营收超预期，14nm产能利用率提升",
				url: "https://finance.example.com/smic-q4",
				description: "中芯国际2025年Q4营收同比增长25%...",
				age: "5h",
			},
		],
		新能源: [
			{
				title: "宁德时代固态电池突破500Wh/kg",
				url: "https://news.example.com/catl-solid-state",
				description: "第二代全固态电池能量密度达到500Wh/kg...",
				age: "3h",
			},
		],
		AI: [
			{
				title: "英伟达B300发布，国内AI服务器厂商受益",
				url: "https://tech.example.com/nvidia-b300",
				description: "Blackwell B300单卡AI训练算力较H100提升3倍...",
				age: "6h",
			},
		],
	};

	const allResults = Object.values(mockResults).flat();
	const keywords = params.query.toLowerCase();
	return allResults
		.filter(
			(r) =>
				r.title.toLowerCase().includes(keywords) ||
				r.description.toLowerCase().includes(keywords) ||
				keywords.split(/\s+/).some(
					(kw) =>
						r.title.includes(kw) || r.description.includes(kw),
				),
		)
		.slice(0, params.count ?? 5);
}

// ============================================================
// 2. Web Fetch — 抓取全文（模拟 Moltbot web_fetch 工具）
// ============================================================

type FetchResult = {
	url: string;
	title: string;
	content: string;
	extractMode: string;
};

/**
 * 模拟 Moltbot 的 web_fetch 工具
 *
 * 实际调用时等价于:
 *   Agent 使用 web_fetch({ url: "...", extractMode: "markdown" })
 *   底层用 readability 提取正文，转为 Markdown
 *   支持 Firecrawl 处理 JS 渲染页面
 *   内置 60 分钟缓存
 */
function simulateWebFetch(params: {
	url: string;
	extractMode?: "markdown" | "text";
	maxChars?: number;
}): FetchResult {
	console.log(`  📄 web_fetch(url="${params.url}", mode="${params.extractMode ?? "markdown"}")`);

	// 模拟抓取结果
	const mockPages: Record<string, FetchResult> = {
		"https://news.example.com/semiconductor-policy": {
			url: params.url,
			title: "国务院发布芯片产业扶持新政策",
			extractMode: params.extractMode ?? "markdown",
			content: `# 国务院发布芯片产业扶持新政策

## 核心要点

1. **研发投入**: 未来五年投入超过 5000 亿元用于集成电路产业
2. **设备国产化**: 28nm 及以上制程设备国产化率目标 70%
3. **人才培养**: 新增 10 所集成电路相关学科建设高校
4. **税收优惠**: 集成电路企业所得税减免延长至 2030 年

## 受益方向

- **半导体设备**: 北方华创、中微公司、盛美上海
- **晶圆代工**: 中芯国际、华虹公司
- **EDA 软件**: 华大九天、概伦电子

## 市场影响

分析师普遍认为该政策力度超预期，短期内半导体板块有望迎来估值修复。`,
		},
		"https://tech.example.com/nvidia-b300": {
			url: params.url,
			title: "英伟达B300发布",
			extractMode: params.extractMode ?? "markdown",
			content: `# 英伟达 B300 发布: AI 算力再突破

英伟达CEO黄仁勋在GTC大会上发布新一代 Blackwell B300 GPU:

- **算力**: 单卡 AI 训练性能较 H100 提升 3 倍
- **能效比**: 每瓦算力提升 2.5 倍
- **中国区**: 合规版本 Q2 上市

**国内受益标的**: 浪潮信息(AI 服务器)、中科曙光(算力基础设施)`,
		},
	};

	const result = mockPages[params.url];
	if (result) return result;

	return {
		url: params.url,
		title: "Page Not Found",
		extractMode: params.extractMode ?? "markdown",
		content: "(模拟) 页面内容未找到",
	};
}

// ============================================================
// 3. 新闻采集管线
// ============================================================

type CollectedNews = {
	title: string;
	url: string;
	summary: string;
	fullContent?: string;
	keywords: string[];
};

function extractKeywords(text: string): string[] {
	const keywords = [
		"半导体", "芯片", "光刻", "晶圆", "GPU", "AI", "算力",
		"锂电", "光伏", "新能源", "储能", "白酒", "茅台",
		"创新药", "医疗器械", "PD-1", "FDA",
		"利好", "利空", "涨停", "跌停",
	];
	return keywords.filter((kw) => text.includes(kw));
}

async function collectNews(sectorQuery: string): Promise<CollectedNews[]> {
	console.log(`\n📡 采集 "${sectorQuery}" 相关新闻...`);

	// Step 1: 搜索
	const searchResults = simulateWebSearch({
		query: sectorQuery,
		count: 5,
		freshness: "pd", // 只看过去一天
	});

	console.log(`  找到 ${searchResults.length} 条结果`);

	// Step 2: 抓取全文
	const collected: CollectedNews[] = [];
	for (const result of searchResults) {
		const page = simulateWebFetch({
			url: result.url,
			extractMode: "markdown",
			maxChars: 50000,
		});

		collected.push({
			title: result.title,
			url: result.url,
			summary: result.description,
			fullContent: page.content,
			keywords: extractKeywords(`${result.title} ${page.content}`),
		});
	}

	return collected;
}

// ============================================================
// 4. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 3: Web Search/Fetch — 财经新闻采集          ║");
	console.log("╚══════════════════════════════════════════════════╝");

	const queries = ["半导体 政策", "AI 芯片 英伟达"];

	for (const query of queries) {
		const news = await collectNews(query);

		for (const item of news) {
			console.log(`\n  📰 ${item.title}`);
			console.log(`     URL: ${item.url}`);
			console.log(`     关键词: ${item.keywords.join(", ")}`);
			if (item.fullContent) {
				const preview = item.fullContent.split("\n").slice(0, 5).join("\n");
				console.log(`     全文预览:\n     ${preview.replace(/\n/g, "\n     ")}`);
			}
		}
	}

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 新闻采集演示完成");
	console.log("\n📌 Moltbot 实际能力:");
	console.log("  web_search: Brave Search / Perplexity 真实搜索");
	console.log("  web_fetch:  readability 正文提取 + 60 分钟缓存");
	console.log("  Firecrawl:  JavaScript 渲染页面抓取");
	console.log("  freshness:  pd(天) pw(周) pm(月) 时间过滤");
}

main().catch(console.error);
