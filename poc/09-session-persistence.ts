/**
 * POC 9: 对话持久化 (Session) — 分析决策追踪
 *
 * 演示: JSONL 格式持久化对话历史，支持回放和搜索
 * 运行: bun poc/09-session-persistence.ts
 *
 * 展示如何用 Moltbot 的 Session 系统记录分析决策并日后复盘
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIR = join(import.meta.dirname, ".sessions");

// ============================================================
// 1. Session 数据结构（对应 Moltbot JSONL 格式）
// ============================================================

type SessionEntry = {
	role: "user" | "assistant" | "tool" | "system";
	content: string | ToolUseContent[];
	timestamp: string;
	metadata?: Record<string, unknown>;
};

type ToolUseContent = {
	type: "tool_use";
	name: string;
	input: Record<string, unknown>;
};

type ToolResultContent = {
	type: "tool_result";
	name: string;
	output: string;
};

// ============================================================
// 2. Session 管理器（简化版）
// ============================================================

class SessionManager {
	private filePath: string;
	private entries: SessionEntry[] = [];

	constructor(sessionId: string) {
		if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
		this.filePath = join(SESSION_DIR, `${sessionId}.jsonl`);
		this.load();
	}

	private load() {
		if (!existsSync(this.filePath)) return;
		const lines = readFileSync(this.filePath, "utf-8").split("\n").filter(Boolean);
		this.entries = lines.map((line) => JSON.parse(line));
	}

	append(entry: SessionEntry) {
		this.entries.push(entry);
		const line = JSON.stringify(entry) + "\n";
		writeFileSync(this.filePath, line, { flag: "a" });
	}

	getHistory(): SessionEntry[] {
		return [...this.entries];
	}

	search(keyword: string): SessionEntry[] {
		return this.entries.filter((e) => {
			const text = typeof e.content === "string" ? e.content : JSON.stringify(e.content);
			return text.includes(keyword);
		});
	}

	getStats() {
		const userMsgs = this.entries.filter((e) => e.role === "user").length;
		const assistantMsgs = this.entries.filter((e) => e.role === "assistant").length;
		const toolCalls = this.entries.filter(
			(e) => Array.isArray(e.content) && e.content.some((c: any) => c.type === "tool_use"),
		).length;
		return {
			totalEntries: this.entries.length,
			userMessages: userMsgs,
			assistantMessages: assistantMsgs,
			toolCalls,
			firstEntry: this.entries[0]?.timestamp,
			lastEntry: this.entries[this.entries.length - 1]?.timestamp,
		};
	}

	/** 导出为 Markdown 格式的分析报告 */
	exportAsMarkdown(): string {
		const lines: string[] = ["# 分析会话记录\n"];
		for (const entry of this.entries) {
			const time = entry.timestamp.slice(11, 19);
			if (entry.role === "user") {
				lines.push(`## [${time}] 用户\n`);
				lines.push(String(entry.content) + "\n");
			} else if (entry.role === "assistant") {
				lines.push(`## [${time}] AI 分析\n`);
				if (typeof entry.content === "string") {
					lines.push(entry.content + "\n");
				} else {
					for (const block of entry.content) {
						if (block.type === "tool_use") {
							lines.push(`> 工具调用: \`${block.name}(${JSON.stringify(block.input)})\`\n`);
						}
					}
				}
			} else if (entry.role === "tool") {
				lines.push(`> 工具结果: ${String(entry.content).slice(0, 100)}...\n`);
			}
		}
		return lines.join("\n");
	}
}

// ============================================================
// 3. 模拟一次完整的分析会话
// ============================================================

function simulateAnalysisSession(): SessionManager {
	const session = new SessionManager("stock-analysis-20260202");

	// 用户提问
	session.append({
		role: "user",
		content: "分析今天半导体板块的新闻，评估对龙头股的影响",
		timestamp: "2026-02-02T09:00:00+08:00",
	});

	// Agent 调用 web_search
	session.append({
		role: "assistant",
		content: [
			{
				type: "tool_use",
				name: "web_search",
				input: { query: "半导体 芯片 最新新闻", freshness: "pd" },
			},
		],
		timestamp: "2026-02-02T09:00:01+08:00",
	});

	// 工具返回结果
	session.append({
		role: "tool",
		content: '{"results": [{"title": "国务院发布芯片扶持新政策", "url": "..."}]}',
		timestamp: "2026-02-02T09:00:02+08:00",
	});

	// Agent 调用 memory_search
	session.append({
		role: "assistant",
		content: [
			{
				type: "tool_use",
				name: "memory_search",
				input: { query: "半导体板块 历史分析" },
			},
		],
		timestamp: "2026-02-02T09:00:03+08:00",
	});

	// 记忆搜索结果
	session.append({
		role: "tool",
		content: "上次分析(2026-01-28): 半导体板块估值处于历史中位，关注政策催化...",
		timestamp: "2026-02-02T09:00:04+08:00",
	});

	// Agent 最终回复
	session.append({
		role: "assistant",
		content: `半导体板块今日分析:

1. 重大利好: 国务院发布芯片扶持新政，五年投入超5000亿
2. 影响评估: 强利好，短期有望推动板块估值修复
3. 龙头股影响:
   - 中芯国际(688981): 直接受益晶圆代工扶持，目标价上调
   - 北方华创(002371): 半导体设备国产替代核心标的
4. 风险提示: 注意获利了结压力，建议分批建仓

结论: 看多半导体板块，建议重点关注中芯国际和北方华创。`,
		timestamp: "2026-02-02T09:00:10+08:00",
		metadata: { model: "claude-opus-4-5", tokens: { input: 2500, output: 800 } },
	});

	return session;
}

// ============================================================
// 4. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 9: Session 持久化 — 分析决策追踪            ║");
	console.log("╚══════════════════════════════════════════════════╝");

	// 模拟会话
	console.log("\n📝 模拟分析会话...\n");
	const session = simulateAnalysisSession();

	// 查看统计
	const stats = session.getStats();
	console.log("📊 会话统计:");
	console.log(`   总条目: ${stats.totalEntries}`);
	console.log(`   用户消息: ${stats.userMessages}`);
	console.log(`   AI 回复: ${stats.assistantMessages}`);
	console.log(`   工具调用: ${stats.toolCalls}`);
	console.log(`   开始时间: ${stats.firstEntry}`);
	console.log(`   结束时间: ${stats.lastEntry}`);

	// 回放对话
	console.log("\n\n📜 会话回放:");
	console.log("─".repeat(60));
	for (const entry of session.getHistory()) {
		const time = entry.timestamp.slice(11, 19);
		const roleLabel = { user: "👤 用户", assistant: "🤖 AI", tool: "🔧 工具", system: "⚙️ 系统" }[
			entry.role
		];

		console.log(`\n[${time}] ${roleLabel}:`);
		if (typeof entry.content === "string") {
			const preview = entry.content.length > 200 ? entry.content.slice(0, 200) + "..." : entry.content;
			console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
		} else {
			for (const block of entry.content) {
				if (block.type === "tool_use") {
					console.log(`  调用 ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
				}
			}
		}
	}

	// 搜索历史
	console.log("\n\n🔍 搜索历史:");
	console.log("─".repeat(60));
	const searchResults = session.search("中芯国际");
	console.log(`  搜索 "中芯国际": 找到 ${searchResults.length} 条匹配`);
	for (const r of searchResults) {
		const text = typeof r.content === "string" ? r.content.slice(0, 80) : "[工具调用]";
		console.log(`    [${r.role}] ${text}...`);
	}

	// 导出 Markdown
	console.log("\n\n📄 导出为 Markdown:");
	console.log("─".repeat(60));
	const md = session.exportAsMarkdown();
	console.log(md.slice(0, 500) + "...");

	const mdPath = join(SESSION_DIR, "analysis-report.md");
	writeFileSync(mdPath, md);
	console.log(`\n  已保存到: ${mdPath}`);

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ Session 持久化演示完成");
	console.log("\n📌 Moltbot 的 Session 系统:");
	console.log("  - JSONL 格式，每行一条消息，追加写入");
	console.log("  - 自动保存完整对话历史 (含工具调用)");
	console.log("  - 可被 Memory 系统索引，支持语义搜索");
	console.log("  - 支持会话导出、回放、统计");
}

main().catch(console.error);
