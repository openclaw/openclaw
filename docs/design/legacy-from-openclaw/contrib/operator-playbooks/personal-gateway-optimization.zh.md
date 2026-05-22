# OpenClaw 个人双通道网关：配置优化说明（中文）

面向：**单人使用**，**飞书**做工作联络、**微信插件**做个人生活线；与工作区拆分、降噪、记忆里层与构建修复对齐。

> **极简四件套**：仅 **飞书 + 微信 + Qwen（自建） + 本机 Orio**，见 **`contrib/examples/minimal-feishu-weixin-qwen-orio.zh.md`**。

脚本路径：**`scripts/optimize-personal-two-channel-config.mjs`**  
推荐阅读官方路由文档：**`docs/channels/channel-routing.md`**、**`docs/channels/feishu.md`**、**`docs/gateway/config-agents.md`**。

---

## 一、优化目标（脚本做了什么）

| 维度                          | 内容                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **绑定（bindings）**          | **飞书** `default`（或环境变量指定 account）→ **`main`**；**`openclaw-weixin`** → **`personal-life`**。                                                                                                           |
| **关闭未使用通道**            | 将 WhatsApp / Telegram / Discord / Google Chat / Slack / Signal / iMessage / Line 的 **`channels.*.enabled`** 设为 **`false`**，减少告警与无谓加载。**不**在此处改 Matrix / Mattermost 等（若配置了需自行收紧）。 |
| **插件条目**                  | 与上述通道对应的 **`plugins.entries.*.enabled: false`**；**`openclaw-weixin`** 保持 **`enabled: true`**。                                                                                                         |
| **飞书仅私聊常用**            | **`channels.feishu.groupPolicy = "disabled"`**；若要用群请参阅通道文档调整。                                                                                                                                      |
| **`personal-life` 条目**      | 若不存在则新增；若已存在则同步 **`tools.deny`** 为最小高危列表（电源/关机/重启、短信、通讯录写入）。                                                                                                              |
| **`main` 工具策略**           | 默认不改写已有 **`main`**；若需与 `personal-life` 同风格最小拒绝列表，设 **`OPENCLAW_OPTIMIZE_MAIN_PERMISSIVE_TOOLS=1`**。                                                                                        |
| **智能体 `main`**             | 若列表中无 **`main`**，会插入默认 workspace / agentDir 桩；已有则不覆盖。不想自动补 **`main`** 时设 **`OPENCLAW_OPTIMIZE_SKIP_MAIN_STUB=1`**。                                                                    |
| **默认 agent**                | 仅 **`main`** 带 **`default: true`**。                                                                                                                                                                            |
| **memory-core + memory-wiki** | 合并启用与 bridge 配置（若条目曾为 **`enabled: false`** 且未设 **`FORCE`**，则跳过对应项）。                                                                                                                      |
| **Control UI**                | 若 **`gateway.controlUi.root`** 指向全局 **`node_modules/openclaw`** 且本仓库存在 **`dist/control-ui`**，则改指向仓库构建产物。                                                                                   |
| **meta**                      | 写入 **`lastTouchedAt`** 等。                                                                                                                                                                                     |
| **tavily + Orio**             | 当设置 **`OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL`**（或 **`TAVILY_BASE_URL` 别名**）时，合并 **`tools.web.search`** 与 **`plugins.entries.tavily.config.webSearch.baseUrl`**。                                     |

备份：仅 **`--apply`** 时复制带时间戳的 **`openclaw.json` 备份**；**`--dry-run`** 不写盘。

---

## 二、环境变量（可选）

| 变量                                                  | 含义                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **`OPENCLAW_CONFIG_PATH`**                            | 配置文件路径（默认 **`~/.openclaw/openclaw.json`**）。                                                                        |
| **`OPENCLAW_OPTIMIZE_FEISHU_ACCOUNT_ID`**             | 飞书多账号时与 **`bindings`** 里 **`accountId`** 一致（默认 **`default`**）。                                                 |
| **`OPENCLAW_OPTIMIZE_WEIXIN_ACCOUNT_ID`**             | 微信插件多账号（默认 **`default`**）。                                                                                        |
| **`OPENCLAW_OPTIMIZE_EMBED_PROVIDER_ID`**             | 写入 **`agents.defaults.memorySearch.provider`**（与 **`MODEL_ID`** 成对使用更完整）。                                        |
| **`OPENCLAW_OPTIMIZE_EMBED_MODEL_ID`**                | 嵌入模型 id。                                                                                                                 |
| **`OPENCLAW_OPTIMIZE_EMBED_REMOTE_BASE_URL`**         | **`memorySearch.remote.baseUrl`**（OpenAI 兼容）。                                                                            |
| **`OPENCLAW_OPTIMIZE_EMBED_REMOTE_API_KEY`**          | **`memorySearch.remote.apiKey`**，或 **`env:变量名`**。                                                                       |
| **`OPENCLAW_OPTIMIZE_EMBED_QUERY_INPUT_TYPE`**        | 可选：**`memorySearch.queryInputType`**。                                                                                     |
| **`OPENCLAW_OPTIMIZE_EMBED_DOCUMENT_INPUT_TYPE`**     | 可选：**`memorySearch.documentInputType`**。                                                                                  |
| **`OPENCLAW_OPTIMIZE_MEMORY_WIKI_VAULT_PATH`**        | wiki vault 路径，覆盖默认 **`~/.openclaw/memory-wiki-vault`**。                                                               |
| **`OPENCLAW_OPTIMIZE_SKIP_MAIN_STUB`**                | **`1`** 时不自动插入 **`main`**。                                                                                             |
| **`OPENCLAW_OPTIMIZE_SKILL_EXTRA_DIRS`**              | 逗号分隔，追加 **`skills.load.extraDirs`**。                                                                                  |
| **`OPENCLAW_OPTIMIZE_FORCE_MEMORY_CORE`**             | 若 **`memory-core`** 曾为 **`disabled`**，**`1`** 仍强制启用。                                                                |
| **`OPENCLAW_OPTIMIZE_FORCE_MEMORY_WIKI`**             | 若 **`memory-wiki`** 曾为 **`disabled`**，**`1`** 仍强制合并。                                                                |
| **`OPENCLAW_OPTIMIZE_MAIN_PERMISSIVE_TOOLS`**         | **`1`** 时 **`main`** 的 **`tools.deny`** 与 **`personal-life`** 对齐。**旧拼写**：`OPENCLAW_OPTIMIZE_MAIN_PERMISIVE_TOOLS`。 |
| **`OPENCLAW_OPTIMIZE_SESSION_DM_SCOPE`**              | 合并 **`session.dmScope`**（见 **`docs/gateway/config-agents.md`**）。                                                        |
| **`OPENCLAW_OPTIMIZE_MCP_SESSION_IDLE_TTL_MS`**       | 合并 **`mcp.sessionIdleTtlMs`**。                                                                                             |
| **`OPENCLAW_OPTIMIZE_MAIN_TOOLS_PROFILE`**            | 若未设置或为强制模式，写入 **`main.tools.profile`**（如 **`coding`**）。                                                      |
| **`OPENCLAW_OPTIMIZE_PERSONAL_TOOLS_PROFILE`**        | 同上，**`personal-life`**（如 **`messaging`**）。                                                                             |
| **`OPENCLAW_OPTIMIZE_FORCE_TOOLS_PROFILE`**           | **`1`** 时覆盖已有的 **`tools.profile`**。                                                                                    |
| **`OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL`**           | **Orio / Tavily 兼容 HTTP 根**（如 **`http://127.0.0.1:8000`**）。                                                            |
| **`OPENCLAW_OPTIMIZE_TAVILY_BASE_URL`**               | 与上一项等价。                                                                                                                |
| **`OPENCLAW_OPTIMIZE_FORCE_TAVILY_WEB_SEARCH_MERGE`** | **`tavily`** 曾为 **`disabled`** 时仍合并**联网搜索**。                                                                       |

CLI **`--help`** 亦列出部分缩写；全文以本节为准。

---

## 三、终端运行（勿依赖 IDE Agent 改写密钥文件）

```bash
cd /path/to/openclaw

node scripts/optimize-personal-two-channel-config.mjs --help
node scripts/optimize-personal-two-channel-config.mjs --dry-run
node scripts/optimize-personal-two-channel-config.mjs --apply
```

若使用 JSON5 扩展语法，解析失败时脚本会尝试 **json5** 回退。仍建议与 **`openclaw config`** 输出一致。

---

## 四、须手动补齐（脚本不写入通道/云密钥）

| 项                                 | 说明                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`agents.defaults.memorySearch`** | 嵌入与索引：**`openclaw memory index`**（见 **`docs/concepts/memory-search.md`**）。                                                                                                                                                                                                                             |
| **`mcp.servers`**                  | 全局合并；维基 / GitHub / fetch 等见 **`contrib/examples/mcp-integration.openclaw.fragment.json`**、**`contrib/examples/mcp-and-knowledge-integration.zh.md`**。**联网搜索**：**`tavily` + `webSearch.baseUrl` → Orio**，见 **`contrib/examples/oriosearch-web-search.zh.md`**（**不是**单靠 `memory_search`）。 |
| **飞书 / 微信**                    | AppId、租户、令牌等仅存本机与安全存储；见 **`docs/channels/feishu.md`** 与微信插件 README。                                                                                                                                                                                                                      |

---

## 五、合并后验证（仓库根）

1. **`pnpm install`**
2. **`pnpm build`**
3. **`pnpm ui:build`**（若 doctor 提示 Control UI）
4. **`pnpm openclaw doctor`**
5. **`pnpm openclaw gateway restart`**（或 **`pnpm gateway:watch`**）

Orio：**`OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL`** 已合并时，仍需 **本机进程监听**、`**TAVILY_API_KEY`** 占位（若 Orio 未开鉴权，见 **`contrib/examples/oriosearch-web-search.zh.md`\*\*）。

---

## 六、概念辨析：本地图谱 / 记忆检索 / 外网检索

| 类型                       | 说明                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| **OpenClaw `memory-wiki`** | 本地 vault + **`wiki_*`** 工具，见 **`docs/plugins/memory-wiki.md`**。  |
| **`memory_search`**        | 向量 + BM25，见 **`docs/concepts/memory-search.md`**。                  |
| **外网网页**               | **`web_search`（tavily 插件）** → 自托管 Orio 等 **Tavily 兼容 HTTP**。 |

---

## 七、市面资源形态参考（选型用）

公开数据、爬虫、学术 API 等：**授权 / ToS / 限额自负**。脚本**不写入**外链密钥；密钥仅通过 **`openclaw.json` + SecretRef / 环境**维护。
