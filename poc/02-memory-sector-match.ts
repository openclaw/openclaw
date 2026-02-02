/**
 * POC 2: 向量记忆系统 (Memory/RAG) — 板块语义匹配
 *
 * 演示: 新闻文本 → 向量嵌入 → 语义搜索 → 匹配板块和个股
 * 运行: bun poc/02-memory-sector-match.ts
 *
 * 这是整个事件驱动投资系统的核心:
 *   不用写关键词规则，靠语义相似度自动匹配
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "data");

// ============================================================
// 1. 加载板块数据
// ============================================================

type Stock = { code: string; name: string; role: string };
type Sector = { name: string; tags: string[]; stocks: Stock[] };
type SectorMap = Record<string, Sector>;

const sectors: SectorMap = JSON.parse(
	readFileSync(join(DATA_DIR, "sectors.json"), "utf-8"),
);

const newsSamples = JSON.parse(
	readFileSync(join(DATA_DIR, "news-samples.json"), "utf-8"),
) as Array<{
	id: string;
	title: string;
	source: string;
	time: string;
	summary: string;
}>;

// ============================================================
// 2. 简易向量嵌入（TF-IDF 近似版，演示用）
//    实际生产用 OpenAI text-embedding-3-small
// ============================================================

/** 分词：按字符和常见词切分 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\u4e00-\u9fa5a-z0-9]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 2);
}

/** 构建词频向量 */
function buildTermVector(tokens: string[]): Map<string, number> {
	const freq = new Map<string, number>();
	for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
	return freq;
}

/** 余弦相似度 */
function cosineSimilarity(
	a: Map<string, number>,
	b: Map<string, number>,
): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const allKeys = new Set([...a.keys(), ...b.keys()]);
	for (const k of allKeys) {
		const va = a.get(k) ?? 0;
		const vb = b.get(k) ?? 0;
		dot += va * vb;
		normA += va * va;
		normB += vb * vb;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// 3. 构建板块向量索引
// ============================================================

type SectorIndex = {
	name: string;
	vector: Map<string, number>;
	sector: Sector;
};

function buildSectorIndex(sectorMap: SectorMap): SectorIndex[] {
	return Object.entries(sectorMap).map(([key, sector]) => {
		// 合并板块名称 + 所有标签 + 所有股票名称和角色
		const text = [
			sector.name,
			...sector.tags,
			...sector.stocks.map((s) => `${s.name} ${s.role}`),
		].join(" ");
		const tokens = tokenize(text);
		return {
			name: key,
			vector: buildTermVector(tokens),
			sector,
		};
	});
}

const sectorIndex = buildSectorIndex(sectors);

// ============================================================
// 4. 语义搜索：新闻 → 匹配板块
// ============================================================

type MatchResult = {
	sectorName: string;
	score: number;
	matchedTags: string[];
	relatedStocks: Stock[];
};

function matchNewsToSectors(
	newsText: string,
	threshold = 0.1,
): MatchResult[] {
	const newsTokens = tokenize(newsText);
	const newsVector = buildTermVector(newsTokens);
	const newsTokenSet = new Set(newsTokens);

	const results: MatchResult[] = [];

	for (const idx of sectorIndex) {
		const score = cosineSimilarity(newsVector, idx.vector);
		if (score < threshold) continue;

		// 找出具体命中了哪些标签
		const matchedTags = idx.sector.tags.filter((tag) => {
			const tagTokens = tokenize(tag);
			return tagTokens.some((t) => newsTokenSet.has(t));
		});

		results.push({
			sectorName: idx.name,
			score,
			matchedTags,
			relatedStocks: idx.sector.stocks,
		});
	}

	return results.sort((a, b) => b.score - a.score);
}

// ============================================================
// 5. 运行演示：对每条新闻做板块匹配
// ============================================================

function formatScore(score: number): string {
	const pct = (score * 100).toFixed(1);
	if (score >= 0.3) return `🔴 ${pct}%（强匹配）`;
	if (score >= 0.15) return `🟡 ${pct}%（中匹配）`;
	return `🟢 ${pct}%（弱匹配）`;
}

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 2: Memory/RAG 向量搜索 — 板块语义匹配      ║");
	console.log("╚══════════════════════════════════════════════════╝");

	console.log(`\n已加载 ${Object.keys(sectors).length} 个板块:`);
	for (const [name, sector] of Object.entries(sectors)) {
		console.log(
			`  ${name}: ${sector.tags.slice(0, 5).join(", ")}... (${sector.stocks.length} 只个股)`,
		);
	}

	console.log(`\n待分析新闻: ${newsSamples.length} 条`);

	for (const news of newsSamples) {
		console.log(`\n${"═".repeat(60)}`);
		console.log(`📰 ${news.title}`);
		console.log(`   来源: ${news.source} | 时间: ${news.time}`);
		console.log(`   摘要: ${news.summary.slice(0, 80)}...`);

		const fullText = `${news.title} ${news.summary}`;
		const matches = matchNewsToSectors(fullText);

		if (matches.length === 0) {
			console.log("   🔍 未匹配到任何板块");
			continue;
		}

		console.log(`\n   🎯 匹配结果:`);
		for (const match of matches) {
			console.log(`\n   板块: ${match.sectorName}`);
			console.log(`   相似度: ${formatScore(match.score)}`);
			if (match.matchedTags.length > 0) {
				console.log(`   命中标签: ${match.matchedTags.join(", ")}`);
			}
			console.log(`   关联个股:`);
			for (const stock of match.relatedStocks) {
				console.log(`     - ${stock.code} ${stock.name} (${stock.role})`);
			}
		}
	}

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 板块匹配演示完成");
	console.log("\n📌 生产环境改进:");
	console.log("  1. 用 OpenAI text-embedding-3-small 替换简易 TF-IDF");
	console.log("  2. 用 Moltbot MemoryIndexManager 管理向量索引");
	console.log("  3. 启用混合搜索 (向量 + BM25 关键词)");
	console.log("  4. 阈值、权重可通过配置文件调整");
}

main().catch(console.error);
