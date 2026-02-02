# Moltbot 可复用功能 — 股票事件驱动分析项目

## 你的项目需求

```
板块信息 + 新闻信息 + 股票标签
         │
         ▼
   新闻出现 → 匹配标签/板块 → 定位相关股票 → 触发投资决策
```

核心需求拆解：

| 需求 | 说明 |
|------|------|
| 新闻采集 | 定时抓取财经新闻、公告、研报 |
| 语义匹配 | 新闻内容 → 匹配板块标签 → 定位股票 |
| 事件驱动 | 新闻触发后自动分析、自动通知 |
| 知识积累 | 历史分析、决策记录可检索 |
| 多渠道通知 | 买卖信号推送到 Telegram/微信/Slack |
| AI 分析 | 大模型理解新闻含义、判断影响方向 |

---

## Moltbot 可直接复用的 10 个功能

### 1. 定时任务系统 (Cron) — 定时抓新闻

**做什么**: 每隔 N 分钟自动执行一次新闻扫描。

**源码位置**: `src/cron/`

**工作方式**:

```
配置一个 Cron Job:
  schedule: "*/15 * * * *"         ← 每 15 分钟执行一次
  payload: "扫描最新财经新闻，匹配以下板块标签..."
      │
      ▼
  Moltbot 自动唤醒 Agent
      │
      ▼
  Agent 调用 web_search 搜索新闻
      │
      ▼
  Agent 分析新闻内容，匹配板块/标签
      │
      ▼
  如果命中，通过 message 工具发送到 Telegram
```

**支持的调度方式**:

```
一次性:     { kind: "at", atMs: 1706745600000 }       ← 指定时间点
定时循环:   { kind: "every", everyMs: 900000 }         ← 每 15 分钟
Cron 表达式: { kind: "cron", expr: "0 9 * * 1-5" }    ← 工作日早 9 点
```

**你的用法**:
- 工作日开盘前扫描隔夜新闻
- 盘中每 15 分钟检查突发事件
- 收盘后汇总当日板块异动

---

### 2. 向量记忆系统 (Memory/RAG) — 标签语义匹配

**做什么**: 把板块信息、股票标签存成向量，新闻进来时用语义搜索匹配。

**源码位置**: `src/memory/`

**这是你项目最核心的复用点。**

```
预先存储:
  research/sectors/半导体.md    → "芯片, 晶圆, 光刻, 封测, EDA, 台积电..."
  research/sectors/新能源.md    → "锂电, 光伏, 风电, 储能, 碳中和..."
  research/sectors/AI.md       → "大模型, GPU, 算力, 英伟达, 数据中心..."
  research/stocks/贵州茅台.md   → "白酒, 消费升级, 高端白酒, 酱酒..."

新闻进来: "英伟达发布新一代 GPU，算力提升 3 倍"
      │
      ▼
  memory_search(query="英伟达GPU算力")
      │
      ▼
  匹配结果:
    1. research/sectors/AI.md        (score: 0.92)
    2. research/sectors/半导体.md     (score: 0.85)
    3. research/stocks/英伟达.md      (score: 0.95)
```

**技术细节**:

```
嵌入模型选择:
  - OpenAI text-embedding-3-small（推荐，便宜且效果好）
  - Google Gemini Embeddings
  - 本地 llama.cpp（完全免费，离线可用）

存储: SQLite + sqlite-vec 向量扩展
搜索: 混合模式 = 向量相似度 + BM25 关键词匹配
```

**配置**:

```json
{
  "memory": {
    "search": {
      "enabled": true,
      "provider": "openai",
      "extraPaths": ["research/sectors", "research/stocks", "research/tags"]
    }
  }
}
```

---

### 3. 网页抓取工具 (Web Fetch + Web Search) — 新闻采集

**做什么**: 搜索和抓取财经新闻网站内容。

**源码位置**: `src/agents/tools/web-fetch.ts`, `web-search.ts`

**Web Search — 搜索新闻**:

```
web_search({
  query: "半导体 利好 政策 2026",
  count: 10,
  freshness: "pd"       ← 只看过去一天的结果
})

返回:
  [
    { title: "国务院发布芯片扶持政策", url: "...", age: "2h" },
    { title: "台积电扩产消息", url: "...", age: "5h" },
    ...
  ]
```

**Web Fetch — 抓取内容**:

```
web_fetch({
  url: "https://finance.sina.com.cn/...",
  extractMode: "markdown"     ← 自动提取正文，去除广告/导航
})

返回: 干净的 Markdown 格式文章内容
```

**特殊能力**:
- 内置缓存（60 分钟），避免重复抓取
- 支持 Firecrawl 集成，处理 JavaScript 渲染的页面
- SSRF 防护，安全访问外部网站

---

### 4. 浏览器自动化 (Browser) — 抓取动态页面

**做什么**: 对于需要登录或 JS 渲染的金融网站，用真实浏览器抓取。

**源码位置**: `src/browser/`

```
典型场景:

1. 登录东方财富/同花顺，抓取板块资金流向
   browser_start()
   browser_open("https://data.eastmoney.com/bkzj/hy.html")
   browser_snapshot()  ← AI 读取页面内容

2. 抓取实时行情截图
   browser_screenshot()  ← 保存为图片

3. 下载 PDF 研报
   browser_pdf_save()

4. 在券商网站执行复杂操作
   browser_act("selector", "click")
   browser_act("input#search", "type", "贵州茅台")
```

**你的用法**:
- 抓取需要登录的券商研报
- 监控实时板块资金流向
- 截图保存技术分析图表

---

### 5. 多渠道消息推送 (Message Tool) — 投资信号通知

**做什么**: 把分析结果/买卖信号推送到你用的聊天平台。

**源码位置**: `src/agents/tools/message-tool.ts`

```
当检测到重要事件:

message({
  channel: "telegram",
  target: { id: "your_user_id" },
  message: `🔴 板块异动提醒

**半导体板块** 出现重大利好:
国务院发布芯片扶持新政策

关联个股:
- 中芯国际 (688981) — 晶圆代工龙头
- 北方华创 (002371) — 设备龙头
- 韦尔股份 (603501) — CIS 龙头

建议关注开盘表现`,
  buttons: [
    { label: "查看详情", url: "https://..." },
    { label: "加入自选", callback: "watchlist_add_半导体" }
  ]
})
```

**支持的渠道**: Telegram, Discord, Slack, Signal, WhatsApp, Teams, Matrix...

**你的用法**:
- 突发新闻即时推送到 Telegram
- 每日收盘汇总发到 Slack 频道
- 重要买卖信号多渠道同步推送

---

### 6. 插件系统 (Plugin) — 封装你的股票分析逻辑

**做什么**: 把股票分析的核心逻辑封装成 Moltbot 插件，独立维护。

**源码位置**: `src/plugins/`

```
创建你的插件:

extensions/stock-analyzer/
├── package.json
├── PLUGIN.md
└── src/
    ├── index.ts              ← 插件入口
    ├── tools/
    │   ├── stock-lookup.ts   ← 查询股票信息工具
    │   ├── news-scan.ts      ← 新闻扫描工具
    │   ├── sector-match.ts   ← 板块匹配工具
    │   └── signal-gen.ts     ← 信号生成工具
    ├── hooks/
    │   └── news-alert.ts     ← 新闻事件钩子
    └── data/
        ├── sectors.json      ← 板块定义
        └── tags.json         ← 标签体系
```

**插件入口示例**:

```typescript
import type { MoltbotPluginApi } from "moltbot/plugin-sdk";

export default function register(api: MoltbotPluginApi) {
  // 注册自定义工具：股票查询
  api.registerTool((ctx) => ({
    name: "stock_lookup",
    description: "查询股票基本面、技术面、所属板块",
    schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "股票代码，如 600519" },
      },
    },
    async execute(id, params) {
      const data = await fetchStockData(params.ticker);
      return { result: formatStockInfo(data) };
    },
  }));

  // 注册自定义工具：板块匹配
  api.registerTool((ctx) => ({
    name: "sector_match",
    description: "根据新闻内容匹配相关板块和个股",
    schema: {
      type: "object",
      properties: {
        newsText: { type: "string" },
      },
    },
    async execute(id, params) {
      // 结合 memory_search 进行语义匹配
      const matches = await matchSectors(params.newsText);
      return { result: matches };
    },
  }));

  // 注册事件钩子：新闻到达时自动分析
  api.registerHook(["inbound:message"], async (event) => {
    if (isNewsSource(event)) {
      await triggerNewsAnalysis(event, api);
    }
  });
}
```

---

### 7. 钩子系统 (Hooks) — 事件驱动自动化

**做什么**: 在特定事件发生时自动触发动作。

**源码位置**: `src/hooks/`

```
事件驱动流程:

新闻消息到达
    │
    ▼
inbound:message 钩子触发
    │
    ▼
提取新闻关键词
    │
    ▼
调用 memory_search 匹配板块
    │
    ▼
  匹配到板块？
    ├── 是 → 生成分析报告 → 推送通知
    └── 否 → 记录日志，不做操作
```

**内置钩子示例 — 会话记忆**:

Moltbot 已有 `session-memory` 钩子，会自动将每次对话的分析结果保存为 Markdown 文件。你可以复用这个模式：

```
每次分析完一只股票:
  → 自动保存到 research/stocks/贵州茅台-20260202.md
  → 下次分析时可以搜索到历史记录
  → 形成持续积累的研究数据库
```

---

### 8. Agent 工具体系 — AI 自主分析

**做什么**: 让 AI Agent 拥有"搜索新闻 → 匹配板块 → 分析影响 → 发送通知"的完整自主能力。

**源码位置**: `src/agents/tools/`, `src/agents/pi-tools.ts`

```
Agent 拥有的工具链:

┌─────────────────────────────────────────────┐
│               AI Agent 工具箱                 │
├─────────────────────────────────────────────┤
│                                             │
│  信息获取:                                    │
│    web_search    → 搜索财经新闻               │
│    web_fetch     → 抓取文章全文               │
│    browser       → 操作动态网页               │
│                                             │
│  知识管理:                                    │
│    memory_search → 语义搜索历史分析            │
│    memory_get    → 读取特定研究文件            │
│    read/write    → 读写本地文件               │
│                                             │
│  分析执行:                                    │
│    exec          → 运行 Python 脚本           │
│    stock_lookup  → 查股票数据（自定义）         │
│    sector_match  → 匹配板块（自定义）          │
│                                             │
│  结果输出:                                    │
│    message       → 推送到聊天平台              │
│    image         → 生成图表                   │
│    cron          → 设置后续跟踪任务            │
│                                             │
└─────────────────────────────────────────────┘
```

**关键**: Agent 可以自主组合这些工具。你只需要下一条指令：

```
"分析今天半导体板块的新闻，找出可能受益的个股，
 评估影响方向和力度，把结果发到我的 Telegram"
```

Agent 会自动：搜索 → 抓取 → 匹配 → 分析 → 推送。

---

### 9. 对话持久化 (Session) — 分析决策追踪

**做什么**: 每次分析对话都完整记录，可供日后复盘。

**存储位置**: `~/.moltbot/agents/<agentId>/sessions/`

```
会话文件 (JSONL 格式):

{"role":"user","content":"分析英伟达最新财报对A股算力板块的影响"}
{"role":"assistant","tool_use":"web_search","input":{"query":"英伟达 Q4 财报 2026"}}
{"role":"tool","content":"英伟达 Q4 营收 450 亿美元，超预期 15%..."}
{"role":"assistant","tool_use":"memory_search","input":{"query":"A股算力板块"}}
{"role":"tool","content":"匹配: 浪潮信息, 中科曙光, 紫光股份..."}
{"role":"assistant","content":"基于英伟达财报分析，A股算力板块预计..."}
```

**你的用法**:
- 每次分析自动记录完整过程
- 用 memory_search 搜索历史分析
- 定期复盘决策质量

---

### 10. 链接理解 (Link Understanding) — 自动提取新闻要点

**做什么**: 收到一个新闻链接时，自动提取标题、摘要、关键数据。

**源码位置**: `src/link-understanding/`

```
收到链接: https://finance.sina.com.cn/stock/...
    │
    ▼
extractLinksFromMessage()    ← 从消息中提取 URL
    │
    ▼
runLinkUnderstanding()       ← 抓取并解析
    │
    ▼
formatLinkUnderstandingBody() ← 格式化输出
    │
    ▼
输出:
  标题: "央行降准 0.5 个百分点"
  摘要: "中国人民银行决定下调存款准备金率..."
  关键词: 降准, 货币政策, 流动性
```

---

## 完整的事件驱动流程（组合使用）

把上面的功能串起来，就是你要的**事件驱动投资**系统：

```
                    ┌────────────────────┐
                    │    定时触发 (Cron)   │
                    │  每 15 分钟执行一次  │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   新闻采集           │
                    │  web_search 搜新闻  │
                    │  web_fetch 抓全文    │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   语义匹配           │
                    │  memory_search      │
                    │  匹配板块和标签      │
                    └─────────┬──────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
                    ▼                    ▼
             没有匹配               命中板块/标签
             记录日志                    │
                                        ▼
                              ┌────────────────────┐
                              │   AI 深度分析        │
                              │  大模型判断:          │
                              │  - 利好 or 利空?      │
                              │  - 影响多大?          │
                              │  - 持续多久?          │
                              │  - 哪些个股受益?      │
                              └─────────┬──────────┘
                                        │
                                        ▼
                              ┌────────────────────┐
                              │  结果输出             │
                              │  1. 推送到 Telegram   │
                              │  2. 保存到记忆系统    │
                              │  3. 设置跟踪任务      │
                              └────────────────────┘
```

---

## 功能对照表

| 你的需求 | Moltbot 功能 | 源码位置 | 复用难度 |
|---------|-------------|---------|---------|
| 定时扫描新闻 | Cron 定时任务 | `src/cron/` | 直接用 |
| 搜索新闻 | web_search 工具 | `src/agents/tools/web-search.ts` | 直接用 |
| 抓取新闻全文 | web_fetch 工具 | `src/agents/tools/web-fetch.ts` | 直接用 |
| 抓取动态页面 | Browser 自动化 | `src/browser/` | 直接用 |
| 板块/标签语义匹配 | Memory 向量搜索 | `src/memory/` | 直接用 |
| 新闻 → 板块定位 | memory_search + AI | `src/memory/` + Agent | 直接用 |
| AI 分析新闻影响 | Agent 引擎 | `src/agents/pi-embedded-runner/` | 直接用 |
| 多渠道推送 | message 工具 | `src/agents/tools/message-tool.ts` | 直接用 |
| 事件驱动触发 | Hooks 钩子 | `src/hooks/` | 直接用 |
| 分析历史积累 | Memory + Session | `src/memory/` + Session | 直接用 |
| 自定义股票工具 | Plugin 插件系统 | `src/plugins/` | 需开发 |
| 链接自动解析 | Link Understanding | `src/link-understanding/` | 直接用 |
| 图表分析 | Image 视觉理解 | `src/agents/tools/image-tool.ts` | 直接用 |

---

## 快速开始建议

**第一步**: 直接用 Moltbot 的现有能力，不写代码：

```bash
# 1. 配置 Telegram 通知渠道
moltbot config set channels.telegram.accounts[0].token "YOUR_BOT_TOKEN"

# 2. 启用记忆系统
moltbot config set memory.search.enabled true

# 3. 准备板块数据（存为 Markdown 文件）
mkdir -p ~/.moltbot/memory/sectors
echo "半导体: 芯片, 晶圆, 光刻, 封测, EDA..." > ~/.moltbot/memory/sectors/半导体.md
echo "新能源: 锂电, 光伏, 风电, 储能..." > ~/.moltbot/memory/sectors/新能源.md

# 4. 创建定时扫描任务
# （通过对话让 Agent 创建 cron job）
```

**第二步**: 需要更强定制时，开发一个插件 (`extensions/stock-analyzer/`)。

**第三步**: 如果需要完全独立运行，把 Moltbot 的 `src/memory/`、`src/cron/`、`src/agents/tools/web-*.ts` 等模块提取到你自己的项目中。
