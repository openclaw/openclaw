# POC: Moltbot 功能验证 — 股票事件驱动分析

验证 Moltbot 的 10 个核心功能在股票分析场景中的可行性。

每个 POC 都是**独立可运行**的脚本，不需要启动 Moltbot 网关，不需要 API Key。

## 运行方式

```bash
# 运行单个 POC
bun poc/00-full-pipeline.ts      # 完整管线演示（推荐先看这个）
bun poc/01-cron-news-scanner.ts  # 定时任务
bun poc/02-memory-sector-match.ts # 向量搜索板块匹配
# ... 以此类推

# 运行全部
for f in poc/[0-9]*.ts; do echo "=== $f ===" && bun "$f" && echo; done
```

## POC 列表

| # | 文件 | 功能 | 说明 |
|---|------|------|------|
| 00 | `00-full-pipeline.ts` | **完整管线** | 新闻采集→语义匹配→AI分析→推送→持久化 |
| 01 | `01-cron-news-scanner.ts` | Cron 定时任务 | 3 种调度模式：cron 表达式、固定间隔、一次性 |
| 02 | `02-memory-sector-match.ts` | Memory 向量搜索 | 新闻文本→TF-IDF向量→余弦相似度→板块匹配 |
| 03 | `03-web-news-collector.ts` | Web 搜索/抓取 | web_search 搜新闻 + web_fetch 抓全文 |
| 04 | `04-browser-scraper.ts` | 浏览器自动化 | 抓取板块资金流向、个股行情、券商研报 |
| 05 | `05-multichannel-push.ts` | 多渠道推送 | Telegram/Discord/Slack 按渠道适配格式 |
| 06 | `06-plugin-stock-tool.ts` | 插件自定义工具 | stock_lookup + sector_match + sector_summary |
| 07 | `07-hooks-event-driven.ts` | Hooks 事件驱动 | 消息到达→自动检测→触发分析→保存记忆 |
| 08 | `08-agent-autonomous.ts` | Agent 自主分析 | AI 自主编排 5 轮工具调用完成分析+推送 |
| 09 | `09-session-persistence.ts` | Session 持久化 | JSONL 记录→回放→搜索→导出 Markdown |
| 10 | `10-link-understanding.ts` | 链接理解 | URL→抓取→提取实体/情感/板块→汇总 |

## 数据文件

| 文件 | 内容 |
|------|------|
| `data/sectors.json` | 5 个板块定义（半导体、新能源、AI、白酒、医药），含标签和成分股 |
| `data/news-samples.json` | 5 条模拟新闻，覆盖所有板块 |

## 架构映射

```
POC 功能                    Moltbot 源码
─────────                  ──────────
定时任务 (POC 01)      →   src/cron/
向量搜索 (POC 02)      →   src/memory/
网页抓取 (POC 03)      →   src/agents/tools/web-search.ts, web-fetch.ts
浏览器   (POC 04)      →   src/browser/
消息推送 (POC 05)      →   src/agents/tools/message-tool.ts
插件系统 (POC 06)      →   src/plugins/, src/plugin-sdk/
事件钩子 (POC 07)      →   src/hooks/
Agent    (POC 08)      →   src/agents/pi-embedded-runner/
会话持久化 (POC 09)    →   ~/.moltbot/agents/<id>/sessions/
链接理解 (POC 10)      →   src/link-understanding/
```

## 从 POC 到生产

POC 使用模拟数据演示流程。接入真实数据需要：

1. **配置 API Key** — Anthropic/OpenAI 用于 AI 分析，Brave Search 用于新闻搜索
2. **配置渠道** — Telegram Bot Token 用于消息推送
3. **替换嵌入模型** — POC 02 用简易 TF-IDF，生产用 OpenAI text-embedding-3-small
4. **接入真实数据源** — 替换模拟数据为 Wind/东方财富/同花顺 API
5. **启动 Moltbot 网关** — `moltbot gateway run` 统一管理所有功能
