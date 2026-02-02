/**
 * POC 6: 插件系统 (Plugin) — 自定义股票分析工具
 *
 * 演示: 用 Moltbot 的插件系统创建自定义的 stock_lookup 和 sector_match 工具
 * 运行: bun poc/06-plugin-stock-tool.ts
 *
 * 展示如何将股票分析逻辑封装成 Moltbot 插件
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "data");

// ============================================================
// 1. 模拟 Plugin SDK 类型（对应 moltbot/plugin-sdk）
// ============================================================

type ToolSchema = {
	type: "object";
	properties: Record<string, { type: string; description: string }>;
	required?: string[];
};

type ToolDefinition = {
	name: string;
	description: string;
	schema: ToolSchema;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ result: string }>;
};

type PluginApi = {
	id: string;
	registerTool: (tool: ToolDefinition) => void;
	registerHook: (events: string[], handler: (event: unknown) => Promise<void>) => void;
	registerCommand: (cmd: { name: string; description: string; handler: Function }) => void;
};

// ============================================================
// 2. 股票数据层
// ============================================================

type StockInfo = {
	code: string;
	name: string;
	sector: string;
	role: string;
	price?: number;
	change?: number;
	pe?: number;
	marketCap?: string;
};

const sectors = JSON.parse(readFileSync(join(DATA_DIR, "sectors.json"), "utf-8"));

function buildStockDatabase(): Map<string, StockInfo> {
	const db = new Map<string, StockInfo>();
	const mockPrices: Record<string, { price: number; change: number; pe: number; cap: string }> = {
		"688981": { price: 78.5, change: 5.2, pe: 45.3, cap: "6100亿" },
		"002371": { price: 325.8, change: 4.8, pe: 68.2, cap: "1580亿" },
		"300750": { price: 215.0, change: 2.1, pe: 28.5, cap: "9450亿" },
		"600519": { price: 1680.0, change: -0.3, pe: 32.1, cap: "21000亿" },
		"600276": { price: 42.5, change: 1.8, pe: 55.0, cap: "2700亿" },
	};

	for (const [sectorName, sector] of Object.entries(sectors) as [string, any][]) {
		for (const stock of sector.stocks) {
			const mock = mockPrices[stock.code];
			db.set(stock.code, {
				code: stock.code,
				name: stock.name,
				sector: sectorName,
				role: stock.role,
				price: mock?.price,
				change: mock?.change,
				pe: mock?.pe,
				marketCap: mock?.cap,
			});
		}
	}
	return db;
}

const stockDb = buildStockDatabase();

// ============================================================
// 3. 定义自定义工具
// ============================================================

/** 工具 1: stock_lookup — 查询个股信息 */
const stockLookupTool: ToolDefinition = {
	name: "stock_lookup",
	description: "查询股票的基本面、技术面信息及所属板块。输入股票代码或名称。",
	schema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "股票代码(如 600519)或名称(如 贵州茅台)",
			},
		},
		required: ["query"],
	},
	async execute(_id, params) {
		const query = String(params.query);

		// 按代码或名称查找
		let stock: StockInfo | undefined;
		stock = stockDb.get(query);
		if (!stock) {
			for (const s of stockDb.values()) {
				if (s.name.includes(query)) {
					stock = s;
					break;
				}
			}
		}

		if (!stock) return { result: `未找到股票: ${query}` };

		return {
			result: [
				`股票: ${stock.code} ${stock.name}`,
				`板块: ${stock.sector}`,
				`角色: ${stock.role}`,
				stock.price ? `最新价: ¥${stock.price}` : "",
				stock.change !== undefined ? `涨跌幅: ${stock.change > 0 ? "+" : ""}${stock.change}%` : "",
				stock.pe ? `市盈率: ${stock.pe}` : "",
				stock.marketCap ? `市值: ${stock.marketCap}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	},
};

/** 工具 2: sector_match — 根据文本匹配相关板块 */
const sectorMatchTool: ToolDefinition = {
	name: "sector_match",
	description: "根据新闻/事件文本，匹配最相关的板块和个股",
	schema: {
		type: "object",
		properties: {
			text: {
				type: "string",
				description: "新闻标题或事件描述",
			},
		},
		required: ["text"],
	},
	async execute(_id, params) {
		const text = String(params.text);
		const matches: Array<{ sector: string; score: number; tags: string[]; stocks: string[] }> = [];

		for (const [name, sector] of Object.entries(sectors) as [string, any][]) {
			const matchedTags = sector.tags.filter((tag: string) => text.includes(tag));
			const stockNameMatches = sector.stocks.filter((s: any) => text.includes(s.name));

			if (matchedTags.length > 0 || stockNameMatches.length > 0) {
				matches.push({
					sector: name,
					score: matchedTags.length + stockNameMatches.length * 2,
					tags: matchedTags,
					stocks: sector.stocks.map((s: any) => `${s.code} ${s.name}`),
				});
			}
		}

		matches.sort((a, b) => b.score - a.score);

		if (matches.length === 0) return { result: "未匹配到相关板块" };

		return {
			result: matches
				.map((m) => [
					`板块: ${m.sector} (匹配度: ${m.score})`,
					`  命中标签: ${m.tags.join(", ")}`,
					`  关联个股: ${m.stocks.join(", ")}`,
				].join("\n"))
				.join("\n\n"),
		};
	},
};

/** 工具 3: sector_summary — 板块概况 */
const sectorSummaryTool: ToolDefinition = {
	name: "sector_summary",
	description: "获取指定板块的概况：成分股、标签、市场定位",
	schema: {
		type: "object",
		properties: {
			sector: { type: "string", description: "板块名称，如 半导体、新能源" },
		},
		required: ["sector"],
	},
	async execute(_id, params) {
		const sectorName = String(params.sector);
		const sector = sectors[sectorName];
		if (!sector) return { result: `未找到板块: ${sectorName}` };

		return {
			result: [
				`板块: ${sector.name}`,
				`标签: ${sector.tags.join(", ")}`,
				`成分股:`,
				...sector.stocks.map((s: any) => `  - ${s.code} ${s.name} (${s.role})`),
			].join("\n"),
		};
	},
};

// ============================================================
// 4. 模拟插件注册流程
// ============================================================

function simulatePluginRegistration() {
	const registeredTools: ToolDefinition[] = [];
	const registeredHooks: string[] = [];
	const registeredCommands: string[] = [];

	const api: PluginApi = {
		id: "stock-analyzer",
		registerTool(tool) {
			registeredTools.push(tool);
			console.log(`  ✅ 注册工具: ${tool.name} — ${tool.description}`);
		},
		registerHook(events, _handler) {
			registeredHooks.push(...events);
			console.log(`  ✅ 注册钩子: ${events.join(", ")}`);
		},
		registerCommand(cmd) {
			registeredCommands.push(cmd.name);
			console.log(`  ✅ 注册命令: /${cmd.name} — ${cmd.description}`);
		},
	};

	// 这就是你的插件入口函数
	console.log("\n📦 注册 stock-analyzer 插件...\n");

	api.registerTool(stockLookupTool);
	api.registerTool(sectorMatchTool);
	api.registerTool(sectorSummaryTool);

	api.registerHook(["inbound:message"], async () => {});
	api.registerCommand({
		name: "stock",
		description: "快速查询股票信息",
		handler: () => {},
	});

	return { registeredTools, registeredHooks, registeredCommands };
}

// ============================================================
// 5. 运行演示：模拟 Agent 调用自定义工具
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 6: Plugin 插件 — 自定义股票分析工具         ║");
	console.log("╚══════════════════════════════════════════════════╝");

	const { registeredTools } = simulatePluginRegistration();

	// 模拟 Agent 调用工具
	console.log("\n\n🤖 模拟 Agent 调用自定义工具:\n");

	// 调用 stock_lookup
	console.log("─".repeat(50));
	console.log('Agent: stock_lookup({ query: "600519" })');
	const r1 = await registeredTools[0]!.execute("call-1", { query: "600519" });
	console.log(`结果:\n${r1.result}\n`);

	// 调用 sector_match
	console.log("─".repeat(50));
	console.log('Agent: sector_match({ text: "国务院加大对光刻机等半导体设备的研发投入" })');
	const r2 = await registeredTools[1]!.execute("call-2", {
		text: "国务院加大对光刻机等半导体设备的研发投入",
	});
	console.log(`结果:\n${r2.result}\n`);

	// 调用 sector_summary
	console.log("─".repeat(50));
	console.log('Agent: sector_summary({ sector: "AI人工智能" })');
	const r3 = await registeredTools[2]!.execute("call-3", { sector: "AI人工智能" });
	console.log(`结果:\n${r3.result}`);

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 插件工具演示完成");
	console.log("\n📌 实际插件目录结构:");
	console.log("  extensions/stock-analyzer/");
	console.log("  ├── package.json");
	console.log("  ├── PLUGIN.md");
	console.log("  └── src/");
	console.log("      ├── index.ts         ← register(api) 入口");
	console.log("      ├── stock-lookup.ts   ← stock_lookup 工具");
	console.log("      ├── sector-match.ts   ← sector_match 工具");
	console.log("      └── data/sectors.json ← 板块数据");
}

main().catch(console.error);
