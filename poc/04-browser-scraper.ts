/**
 * POC 4: 浏览器自动化 (Browser) — 抓取动态金融页面
 *
 * 演示: 用 Moltbot 的浏览器工具抓取需要 JS 渲染的金融网站
 * 运行: bun poc/04-browser-scraper.ts
 *
 * 展示浏览器自动化在股票分析中的应用场景
 */

// ============================================================
// 1. 浏览器操作模拟（对应 Moltbot browser-tool.ts 的各个操作）
// ============================================================

type BrowserAction =
	| { type: "start" }
	| { type: "open"; url: string }
	| { type: "snapshot" }
	| { type: "act"; selector: string; action: string; value?: string }
	| { type: "screenshot"; path: string }
	| { type: "pdfSave"; path: string }
	| { type: "stop" };

type BrowserState = {
	running: boolean;
	currentUrl: string;
	tabs: string[];
};

const state: BrowserState = { running: false, currentUrl: "", tabs: [] };

function executeBrowserAction(action: BrowserAction): string {
	switch (action.type) {
		case "start":
			state.running = true;
			console.log("  🌐 browser_start() → 浏览器已启动");
			return "Browser started";

		case "open":
			state.currentUrl = action.url;
			state.tabs.push(action.url);
			console.log(`  🔗 browser_open("${action.url}") → 页面已加载`);
			return `Navigated to ${action.url}`;

		case "snapshot":
			console.log("  📸 browser_snapshot() → AI 读取页面内容");
			return getPageSnapshot(state.currentUrl);

		case "act":
			console.log(`  👆 browser_act("${action.selector}", "${action.action}"${action.value ? `, "${action.value}"` : ""})`);
			return `Performed ${action.action} on ${action.selector}`;

		case "screenshot":
			console.log(`  📷 browser_screenshot() → 保存到 ${action.path}`);
			return `Screenshot saved to ${action.path}`;

		case "pdfSave":
			console.log(`  📄 browser_pdf_save() → 保存到 ${action.path}`);
			return `PDF saved to ${action.path}`;

		case "stop":
			state.running = false;
			state.tabs = [];
			console.log("  ⏹  browser_stop() → 浏览器已关闭");
			return "Browser stopped";
	}
}

function getPageSnapshot(url: string): string {
	const snapshots: Record<string, string> = {
		"https://data.eastmoney.com/bkzj/hy.html": `
行业板块资金流向 (实时)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
板块名称      | 今日净流入   | 涨跌幅  | 领涨股
半导体        | +52.3亿     | +3.2%  | 中芯国际
人工智能      | +38.7亿     | +2.8%  | 浪潮信息
新能源车      | +15.2亿     | +1.5%  | 宁德时代
白酒          | -8.5亿      | -0.6%  | 贵州茅台
医药生物      | -12.3亿     | -1.1%  | 恒瑞医药
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
更新时间: ${new Date().toLocaleTimeString("zh-CN")}`,

		"https://quote.eastmoney.com/concept/bk0891.html": `
半导体板块详情
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
代码     | 名称       | 最新价  | 涨跌幅  | 成交额
688981  | 中芯国际    | 78.50  | +5.2%  | 42.3亿
002371  | 北方华创    | 325.80 | +4.8%  | 28.7亿
603501  | 韦尔股份    | 112.30 | +3.5%  | 15.2亿
688008  | 澜起科技    | 89.60  | +3.1%  | 8.9亿
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
板块涨跌幅: +3.2% | 总成交额: 285.6亿`,
	};

	return snapshots[url] ?? `(页面内容: ${url})`;
}

// ============================================================
// 2. 场景演示：抓取板块资金流向
// ============================================================

async function scenarioFundFlow() {
	console.log("\n📊 场景 1: 抓取板块资金流向");
	console.log("─".repeat(50));

	executeBrowserAction({ type: "start" });
	executeBrowserAction({
		type: "open",
		url: "https://data.eastmoney.com/bkzj/hy.html",
	});

	const snapshot = executeBrowserAction({ type: "snapshot" });
	console.log(`\n  页面内容:\n${snapshot}`);

	executeBrowserAction({
		type: "screenshot",
		path: "/tmp/fund-flow.png",
	});
	executeBrowserAction({ type: "stop" });
}

// ============================================================
// 3. 场景演示：抓取板块个股详情
// ============================================================

async function scenarioSectorDetail() {
	console.log("\n\n📈 场景 2: 抓取半导体板块个股详情");
	console.log("─".repeat(50));

	executeBrowserAction({ type: "start" });
	executeBrowserAction({
		type: "open",
		url: "https://quote.eastmoney.com/concept/bk0891.html",
	});

	// 模拟点击排序（按涨跌幅排序）
	executeBrowserAction({
		type: "act",
		selector: "th.sort-change-pct",
		action: "click",
	});

	const snapshot = executeBrowserAction({ type: "snapshot" });
	console.log(`\n  页面内容:\n${snapshot}`);

	// 保存 PDF
	executeBrowserAction({
		type: "pdfSave",
		path: "/tmp/semiconductor-stocks.pdf",
	});
	executeBrowserAction({ type: "stop" });
}

// ============================================================
// 4. 场景演示：登录券商网站下载研报
// ============================================================

async function scenarioBrokerReport() {
	console.log("\n\n📑 场景 3: 登录券商下载研报（流程演示）");
	console.log("─".repeat(50));

	executeBrowserAction({ type: "start" });
	executeBrowserAction({
		type: "open",
		url: "https://broker.example.com/login",
	});

	// 填写登录表单
	executeBrowserAction({
		type: "act",
		selector: "input#username",
		action: "type",
		value: "user@example.com",
	});
	executeBrowserAction({
		type: "act",
		selector: "input#password",
		action: "type",
		value: "********",
	});
	executeBrowserAction({
		type: "act",
		selector: "button#login",
		action: "click",
	});

	// 导航到研报页面
	executeBrowserAction({
		type: "open",
		url: "https://broker.example.com/research/semiconductor",
	});

	// 下载 PDF 研报
	executeBrowserAction({
		type: "act",
		selector: "a.download-pdf:first-child",
		action: "click",
	});

	console.log("  📥 研报下载中...");
	console.log("  ✅ 研报已保存到 /tmp/semiconductor-report.pdf");

	executeBrowserAction({ type: "stop" });
}

// ============================================================
// 5. 运行演示
// ============================================================

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  POC 4: Browser 自动化 — 抓取动态金融页面        ║");
	console.log("╚══════════════════════════════════════════════════╝");

	await scenarioFundFlow();
	await scenarioSectorDetail();
	await scenarioBrokerReport();

	console.log(`\n${"═".repeat(60)}`);
	console.log("\n✅ 浏览器自动化演示完成");
	console.log("\n📌 Moltbot 的 Browser 工具提供:");
	console.log("  - Playwright 驱动的真实 Chrome 浏览器");
	console.log("  - AI 语义快照 (browser_snapshot)，直接理解页面内容");
	console.log("  - 支持登录态保持 (Chrome Profile)");
	console.log("  - 截图、PDF 保存、文件下载");
	console.log("  - JavaScript 执行、DOM 操作");
}

main().catch(console.error);
