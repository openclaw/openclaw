# 工作 / 生活双场景：Skills 能力落地 + MCP / Wiki / 开放数据对接参考

面向：在 OpenClaw 里用 **`main`（工作）** 与 **`personal-life`（生活）** 两条智能体线，**补齐「策略之外的真实能力」**：本地百科、外网知识、政府开放数据、以及仓库文档里**已出现过的 MCP 包名**。

**说明**：第三方 MCP 包名与 API 随生态变化；下表以 **能力域** 为主，落盘前用 `openclaw mcp list` / `openclaw doctor` 与上游 README 核对。密钥只放环境变量或 SecretRef，勿提交 git。

---

## 0. 企业本体 + 知识库（ClaWorks）— 请看专用规范

**不要**在本页混用多种 ClaWorks 接法。企业 **Ontology + KB** 在 OpenClaw 中的**唯一推荐路径**：

- 插件：**`claworks`**（工具 **`cw_kb_ingest`** / **`cw_kb_search`** / **`cw_query_objects`** 等）
- CLI：`openclaw clawworks`（实例健康）、`openclaw clawworks platform …`（启停平台进程）
- **不要**把 ClaWorks 写进 `mcp.servers` 替代插件；**不要**新装 `clawtwin`+`clawops`+`claworks-ops` 三插件

完整概念与命令表：**`contrib/examples/claworks-canonical-guide.zh.md`**。英文：`docs/plugins/claworks.md`、`docs/cli/clawworks.md`。

下文 §1 起主要讲 **OpenClaw 内置 memory-wiki** 与 **通用第三方 MCP**（Fetch 等），与 ClaWorks 互补而非替代。

---

## 0b. 重要澄清：`memory-wiki`「图谱」≠ 独立「搜索引擎」装机

### 「知识图谱」在 OpenClaw 里指什么？

`memory-wiki` **不是**外接 Neo4j / Wikidata SPARQL 那种 **独立图数据库**，而是 **本地 vault 里的结构化知识层**，包括：

- 目录 **`entities/`、`concepts/`、`sources/`** 等；
- 页面的 **结构化 `claims` frontmatter**（主张、证据、置信度、矛盾与未决问题）；
- 编译产物 **`claims.jsonl`**、仪表盘（**`reports/contradictions.md`** 等）。

智能体通过 **`wiki_search` / `wiki_get`**（如 **`openclaw wiki get entity.alpha`**）访问。若要与 **企业图谱 SaaS** 或 **外网百科** 联通，需 **对方暴露 HTTP API 或 MCP**，再用 **Fetch MCP** 或厂商 MCP 接 —— **具体厂商不在本仓库里预置**。

详见 **`docs/plugins/memory-wiki.md`**。

### 「搜索引擎装好了吗？」

OpenClaw **没有**单独的「安装浏览器式搜索引擎」产品线。**回忆侧**检索是 **`memory_search`**：**向量 + BM25 混合**（见 **`docs/concepts/memory-search.md`**）。未配 **`memorySearch` 的 provider/model**、或未 **建索引** 时，效果会弱——请先 **`openclaw memory status --deep`**、`openclaw doctor`、**`openclaw memory index`**。

**联网搜索**是另一条线：工具 **`web_search`**，由已打包的 **`tavily` 插件** 调用 **Tavily 兼容 HTTP API**（路径 **`/search`**、**`/extract`**）。若你自托管 **OrioSearch**，必须把 **API 根地址**写进 **`plugins.entries.tavily.config.webSearch.baseUrl`**（或用环境变量 **`TAVILY_BASE_URL`**），网关才能打到你的 Orio，而不是「装了 Orio 却从未接到 OpenClaw」。**这一步与 `memory_search` 无关**；两者都强，才显得「又记得又会上网」。实操见 **`contrib/examples/oriosearch-web-search.zh.md`**，也可用脚本环境变量 **`OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL`** 合并配置。

---

## 1. 三层能力模型（先对齐概念）

| 层级                                | 是什么                                                                        | 谁负责「质量」                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **A. 内置记忆与百科**               | `memory-core`、`memory_search`、插件 **`memory-wiki`**（本地 vault + bridge） | **你沉淀的内容**决定上限；embedding 配置见 **`docs/concepts/memory-search.md`、`docs/plugins/memory-wiki.md`**。       |
| **B. OpenClaw 配置的 MCP**          | 根 **`mcp.servers`**（stdio / remote HTTP）；Gateway 运行时加载工具           | **外部服务可用性与合规**（ToS、频控、密钥）。CLI：`docs/cli/mcp.md`；字段：`docs/gateway/configuration-reference.md`。 |
| **C. Workspace Skills（SKILL.md）** | **每个 agent workspace** 下的操作说明与流程封装                               | **你写的 procedure**；目录优先级见 **`docs/tools/skills.md`**。                                                        |

**「Wiki 一定要对接」** 在 OpenClaw 里通常指两层：

1. **必做（本地）**：启用 **`memory-wiki` + `memory-core`**，配好 vault / bridge，让智能体能用 **`wiki_search` / `wiki_get`** 并和 **`memory_search corpus=all`** 协同（详见 **`docs/plugins/memory-wiki.md`**）。个人脚本已合并默认桥接意图：`scripts/optimize-personal-two-channel-config.mjs`。
2. **可选（外网「维基」）**：维基媒体等站点一般走 **HTTP**；可用 **Fetch 类 MCP** 调公开 API（例如 MediaWiki `action=query`），**不**把整站当可爬语料库；版权以各站条款为准。

政府开放数据同理：**没有单一「政府 MCP 万能包」**；常见形态是 **REST/CKAN/文件下载**，用 **Fetch MCP + 固定只读 URL 列表** 或 **你方小脚本定时拉取 → 写入 memory-wiki / 工作区 Markdown** 再索引。

---

## 2. 仓库文档里已引用的 MCP 示例（可照抄形态）

| 用途                            | 形态                                                                                               | 出处                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 通用 HTTP 抓取                  | `command` + `npx` + `args: ["-y", "@modelcontextprotocol/server-fetch"]`                           | **`docs/gateway/configuration-reference.md`**                                                              |
| GitHub（Issue/PR 等，需 token） | `args: ["-y", "@modelcontextprotocol/server-github"]`，环境变量 **`GITHUB_PERSONAL_ACCESS_TOKEN`** | **`docs/gateway/secrets.md`**（ACPX 插件内 `mcpServers` 示例；根配置 **`mcp.servers`** 同理，用 `env` 块） |

根配置示例结构（片段）见同目录 **`mcp-integration.openclaw.fragment.json`**（可合并进 `openclaw.json`）。

---

## 3. 按「工作（main）」建议对接的能力域

| 能力域                            | 典型实现思路                                                                                                                                   | Skills 落地（写在 `~/.openclaw/workspace/skills/.../SKILL.md` 等） |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **代码与仓库**                    | GitHub MCP（上表）、本机 repo 用现有 **bash/fs** 工具链；内部 GitLab 多为 **自建 HTTP MCP** 或官方提供的 MCP                                   | 「分支/PR 规范」「Code review 检查单」「发布前 smoke」             |
| **文档与知识库**                  | 公司 Confluence/Notion：**若官方/自建 MCP** 则接；否则 **导出 Markdown → 同步进 memory-wiki vault** 再 `wiki_search`                           | 「文档更新流程」「RFC 模板」                                       |
| **数据与报表**                    | 内网 API：**streamable-http MCP** 或 **fetch**；表格/BI：能 MCP 则接，否则 **定时 job 写 CSV 到 workspace**                                    | 「取数字段说明」「常用 SQL/指标口径」                              |
| **飞书协同**                      | 通道已绑定；Skill 里写 **@人/群/审批** 规范、常用命令、禁止行为                                                                                | 「飞书回复长度与敏感词」「群与私聊边界」                           |
| **政府 / 行业公开数据（工作向）** | 选 **具体开放平台** 的 **稳定 API 基址**（统计、工商、交通等因地区而异），用 **fetch MCP** 只读白名单 URL；**禁止**让 agent 随意拼任意政府域名 | 「本业务允许的开放数据端点列表」「响应字段含义」                   |

---

## 4. 按「生活（personal-life）」建议对接的能力域

| 能力域                 | 典型实现思路                                                                                                                                                                                                                                 | Skills 落地                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **本地「生活百科」**   | 同一套 **memory-wiki**，可用 **独立 vault 路径**（`OPENCLAW_OPTIMIZE_MEMORY_WIKI_VAULT_PATH` 或 per-agent 策略：若需完全隔离，需在配置里为 `personal-life` 单独评估 wiki 插件是否分实例——高阶，默认共享插件用 **不同 workspace 笔记** 即可） | 「家庭事项记录格式」「健康数据勿写进工作区」 |
| **天气 / 日历 / 提醒** | 第三方 **天气/日历 MCP**（选带稳定 SLA 的）；无 MCP 时用 **官方 HTTP API + fetch**                                                                                                                                                           | 「何时查天气」「不用执行危险系统指令」       |
| **消费与公开服务**     | 地图、公交、公开活动 API：**只读 + 固定 endpoint**                                                                                                                                                                                           | 「不提交真实支付密码」                       |
| **政府民生公开数据**   | 与第 3 部分相同：**白名单 URL** + **fetch**；适合 **公积金/交通/教育** 等 **各地开放平台**（入口因城市而异，需你自选）                                                                                                                       | 「仅使用配置里列出的接口」                   |

---

## 5. 「政府开放数据」怎么接才像「能力」而不是一句口号

1. **选定来源**：例如国家级/省级 **数据开放平台**（通常提供 **API 文档 + appKey**），或 **CKAN** 类目录（JSON API）。
2. **接入方式**
   - **MCP**：`server-fetch` 发 **GET** 到 **固定 path**（query 由 agent 在允许参数内拼）；**不要把整网段开放给 agent**。
   - **批处理**：`cron` / 系统定时任务拉取 → 落 **`memory-wiki` 或 workspace 的 `data/`** → 跑 **`openclaw memory index`**（见 **`docs/concepts/memory-search.md`**）。
3. **合规**：只存 **允许再分发的字段**；个人敏感信息 **不要**进 wiki。

---

## 6. 市面上「知识类」扩展还能接什么（能力类，非广告）

以下均为 **常见类别**；是否免费、是否需 key，以各服务商当时条款为准。

| 类别               | 常见形态                                                |
| ------------------ | ------------------------------------------------------- |
| **网页与文档抓取** | Fetch MCP、自建只读代理                                 |
| **学术与引文**     | 开放 API（Crossref、OpenAlex 等）+ 引用规范 Skill       |
| **地图与地理**     | 官方地图 Web API（常需 key）                            |
| **搜索聚合**       | 各类 **Search MCP**（多有免费档 + 限额）                |
| **向量与 RAG**     | 自建 embedding + 已有 `memory_search`；或外部向量库 MCP |

工作线优先 **「可审计、有 SL A 的内网/官方 API」**；生活线优先 **「低敏、只读、固定域名」**。

---

## 7. 建议的下一步（按优先级）

1. **确认 `memory-wiki` + `memory-core` 已 doctor 通过**：`openclaw wiki doctor`，再 **`openclaw memory index`**（见 playbook `contrib/operator-playbooks/personal-gateway-optimization.zh.md`）。
2. **在 `mcp.servers` 增加 `gen-fetch`（server-fetch）**，再按需加 **GitHub**（工作线）。
3. **分别在两个 workspace 各写 2～3 个 SKILL.md**（飞书工作流、个人生活记录规范、政府 API 白名单说明）。
4. **为政府/开放数据选 1～2 个明确 API 基址**，写入 Skill，再接到 fetch。

若你希望本仓库再提供一个 **仅含 `server-fetch` 条目的 `openclaw.json` 合并片段**，已放在 **`contrib/examples/mcp-integration.openclaw.fragment.json`**（可与你的配置合并）。

---

## 8. 想和「业界酷炫 OpenClaw 用法」对齐时，通常还缺什么？（Checklist）

以下多为 **官方文档里零散出现的能力组合**，可作自检；并非「再多装一个神秘资源包」即能变强。

| 方向                            | 常见扩展                                                 | 文档入口                                                                      |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **端与 UI**                     | Control UI、多端应用、局域网/隧道                        | `docs/install/`、`docs/gateway/`                                              |
| **通道与会话**                  | 多通道、WebChat、`session.dmScope` / 会话维护            | `docs/channels/`、`docs/gateway/config-agents.md`                             |
| **MCP**                         | GitHub、Fetch、自建 **`streamable-http`** 等             | `docs/cli/mcp.md`、`docs/gateway/configuration-reference.md`                  |
| **Skills**                      | 各 **`workspace/skills`** 与 **`skills.load.extraDirs`** | `docs/tools/skills.md`                                                        |
| **记忆与 wiki**                 | **嵌入 + 索引**、`wiki compile`、bridge                  | `docs/concepts/memory-search.md`、`docs/plugins/memory-wiki.md`               |
| **油气管场站 AI（模块化落地）** | 主数据 + 规程 + MCP（图/仿真/3D）+ Skills                | **`contrib/operator-playbooks/industrial-pipeline-station-ai-landing.zh.md`** |
| **模型**                        | 多 provider、routing                                     | `docs/gateway/config-tools.md`                                                |

**在仓库协作里能做的**：补充 **示例片段、自检清单、接线说明**。**须由你在本机完成的**：填入 **密钥**、选定 **上游 API/MCP**、**跑 gateway / index / doctor**。缺 **真实数据与 SKILL 内容** 时，再强的模型也显得「不够用」——这不是 OpenClaw 缺资源，而是 **知识尚未沉淀进 vault 与工作区**。
