/**
 * POC 5: 多渠道消息推送 (Message Tool) — 投资信号通知
 *
 * 演示: 检测到投资信号后，推送到多个聊天平台
 * 运行: bun poc/05-multichannel-push.ts
 *
 * 展示 Moltbot 的 message 工具在各渠道的推送能力
 */

// ============================================================
// 1. 消息类型定义
// ============================================================

type StockSignal = {
	type: "bullish" | "bearish" | "neutral";
	sector: string;
	headline: string;
	stocks: Array<{ code: string; name: string; reason: string }>;
	urgency: "high" | "medium" | "low";
	source: string;
	timestamp: string;
};

type MessageTarget = {
	channel: string;
	targetId: string;
	label: string;
	features: string[];
};

// ============================================================
// 2. 定义推送目标
// ============================================================

const pushTargets: MessageTarget[] = [
	{
		channel: "telegram",
		targetId: "user_123456",
		label: "Telegram 个人",
		features: ["inline_buttons", "markdown", "reactions", "silent"],
	},
	{
		channel: "telegram",
		targetId: "group_-100123456",
		label: "Telegram 投资群",
		features: ["inline_buttons", "markdown", "threads", "reactions"],
	},
	{
		channel: "discord",
		targetId: "channel_987654",
		label: "Discord #stock-alerts",
		features: ["embeds", "markdown", "threads", "reactions"],
	},
	{
		channel: "slack",
		targetId: "#investment-alerts",
		label: "Slack #investment-alerts",
		features: ["blocks", "mrkdwn", "threads", "reactions"],
	},
];

// ============================================================
// 3. 格式化消息（按渠道适配）
// ============================================================

function formatSignalForChannel(signal: StockSignal, target: MessageTarget): string {
	const emoji = signal.type === "bullish" ? "🔴" : signal.type === "bearish" ? "🟢" : "⚪";
	const direction = signal.type === "bullish" ? "利好" : signal.type === "bearish" ? "利空" : "中性";
	const urgencyIcon = signal.urgency === "high" ? "‼️" : signal.urgency === "medium" ? "❗" : "ℹ️";

	if (target.channel === "slack") {
		// Slack 用 mrkdwn 格式
		return [
			`${urgencyIcon} *${signal.sector}板块 ${direction}信号*`,
			`> ${signal.headline}`,
			"",
			"*关联个股:*",
			...signal.stocks.map((s) => `• \`${s.code}\` *${s.name}* — ${s.reason}`),
			"",
			`_来源: ${signal.source} | ${signal.timestamp}_`,
		].join("\n");
	}

	// Telegram / Discord 用 Markdown
	return [
		`${urgencyIcon} **${signal.sector}板块 ${direction}信号**`,
		"",
		`> ${signal.headline}`,
		"",
		"**关联个股:**",
		...signal.stocks.map((s) => `  ${emoji} \`${s.code}\` **${s.name}** — ${s.reason}`),
		"",
		`_来源: ${signal.source} | ${signal.timestamp}_`,
	].join("\n");
}

// ============================================================
// 4. 模拟消息推送（对应 Moltbot message-tool.ts）
// ============================================================

type MessagePayload = {
	channel: string;
	target: string;
	message: string;
	buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
	silent?: boolean;
};

function simulateMessageSend(payload: MessagePayload): void {
	console.log(`  📤 message({`);
	console.log(`       channel: "${payload.channel}",`);
	console.log(`       target: "${payload.target}",`);
	console.log(`       message: "...(${payload.message.length} 字符)",`);
	if (payload.buttons) {
		console.log(`       buttons: ${JSON.stringify(payload.buttons.map((row) => row.map((b) => b.text)))},`);
	}
	if (payload.silent) console.log(`       silent: true,`);
	console.log(`     })`);
	console.log(`     → ✅ 已发送`);
}

// ============================================================
// 5. 信号推送逻辑
// ============================================================

async function pushSignal(signal: StockSignal) {
	console.log(`\n${"─".repeat(60)}`);
	console.log(`📢 推送信号: ${signal.sector} ${signal.type === "bullish" ? "利好" : "利空"}`);
	console.log(`   标题: ${signal.headline}`);
	console.log(`   紧急度: ${signal.urgency}`);

	for (const target of pushTargets) {
		console.log(`\n  → 推送到 ${target.label} (${target.channel}):`);

		const formattedMessage = formatSignalForChannel(signal, target);

		const payload: MessagePayload = {
			channel: target.channel,
			target: target.targetId,
			message: formattedMessage,
		};

		// Telegram 支持行内按钮
		if (target.channel === "telegram" && target.features.includes("inline_buttons")) {
			payload.buttons = [
				[
					{ text: "查看详情", url: `https://finance.example.com/news/${signal.source}` },
					{ text: "加入自选", callback_data: `watchlist:${signal.sector}` },
				],
				[
					{ text: "忽略此板块", callback_data: `mute:${signal.sector}:1h` },
				],
			];
		}

		// 低紧急度信号静默发送
		if (signal.urgency === "low") {
			payload.silent = true;
		}

		simulateMessageSend(payload);
	}
}

// ============================================================
// 6. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 5: 多渠道消息推送 — 投资信号通知            ║");
	console.log("╚══════════════════════════════════════════════════╝");

	console.log(`\n已配置 ${pushTargets.length} 个推送目标:`);
	for (const t of pushTargets) {
		console.log(`  - ${t.label}: ${t.features.join(", ")}`);
	}

	// 信号 1: 高紧急度利好
	await pushSignal({
		type: "bullish",
		sector: "半导体",
		headline: "国务院发布芯片产业扶持新政策，计划五年投入超 5000 亿元",
		stocks: [
			{ code: "688981", name: "中芯国际", reason: "晶圆代工直接受益" },
			{ code: "002371", name: "北方华创", reason: "半导体设备国产替代" },
		],
		urgency: "high",
		source: "新华社",
		timestamp: new Date().toLocaleString("zh-CN"),
	});

	// 信号 2: 中紧急度利好
	await pushSignal({
		type: "bullish",
		sector: "新能源",
		headline: "宁德时代固态电池突破 500Wh/kg，预计 2027 年量产",
		stocks: [
			{ code: "300750", name: "宁德时代", reason: "技术领先，直接受益" },
			{ code: "002459", name: "晶澳科技", reason: "新能源产业链联动" },
		],
		urgency: "medium",
		source: "财联社",
		timestamp: new Date().toLocaleString("zh-CN"),
	});

	// 信号 3: 低紧急度中性
	await pushSignal({
		type: "neutral",
		sector: "消费白酒",
		headline: "白酒行业 Q4 库存数据公布，整体去化节奏符合预期",
		stocks: [
			{ code: "600519", name: "贵州茅台", reason: "龙头稳健，关注批价" },
		],
		urgency: "low",
		source: "中国证券报",
		timestamp: new Date().toLocaleString("zh-CN"),
	});

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 多渠道推送演示完成");
	console.log("\n📌 Moltbot 的 message 工具支持:");
	console.log("  - 15+ 渠道: Telegram, Discord, Slack, Signal, WhatsApp...");
	console.log("  - 行内按钮 (Telegram), Embeds (Discord), Blocks (Slack)");
	console.log("  - 静默模式、线程回复、表情反应");
	console.log("  - 媒体附件: 图片、文件、语音");
}

main().catch(console.error);
