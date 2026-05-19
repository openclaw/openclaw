# ClaWorks Fork 改造计划

> 这份文档回答：从 openclaw fork 过来之后，**哪些文件要改、哪些扩展要保留、哪些要删除**。
>
> 原则：**最小改动**。内部 TS 标识符不重命名（保持 openclaw\* 变量名），只改用户可见的品牌表面和新增 ClaWorks 核心代码。

---

## 一、需要改动的核心文件（已改或待改）

### 1.1 已完成

| 文件           | 改动                                                       | 状态 |
| -------------- | ---------------------------------------------------------- | ---- |
| `package.json` | `name: claworks`, `bin: claworks`, 版本 `2026.5.0-alpha.1` | ✅   |
| `README.md`    | 全新 ClaWorks 定位说明                                     | ✅   |

### 1.2 待改（品牌表面）

| 文件                               | 需要改什么                                      | 优先级 |
| ---------------------------------- | ----------------------------------------------- | ------ |
| `src/cli/cli.ts` 或 `src/entry.ts` | CLI 欢迎语 banner 从 "OpenClaw" 改为 "ClaWorks" | 低     |
| `src/tui/` 中的 UI 文字            | 标题栏/Footer 显示 "ClaWorks"                   | 低     |
| `openclaw.mjs`                     | 入口保持，添加 claworks 注释说明                | 低     |
| `docs/`                            | 全部文档替换（独立任务，不急于 Phase 1）        | 低     |

> **不改动**：内部变量名、函数名、类名（如 `definePluginEntry`、`OpenClawConfig`、`claworksHttp` 等）。这些保持原样是为了和 upstream openclaw 最小化 merge 冲突。

### 1.3 新增（ClaWorks 核心——Phase 1 主要工作）

| 路径                                   | 内容                                    |
| -------------------------------------- | --------------------------------------- |
| `src/kernel/event-bus.ts`              | EventKernel 事件总线                    |
| `src/kernel/playbook-matcher.ts`       | 事件→Playbook 匹配规则                  |
| `src/kernel/scheduler.ts`              | cron/延迟触发调度器                     |
| `src/planes/data/object-store.ts`      | ObjectStore (Drizzle ORM)               |
| `src/planes/data/ontology-engine.ts`   | 本体加载/验证/查询                      |
| `src/planes/data/knowledge-base.ts`    | KB 语义检索                             |
| `src/planes/orch/playbook-engine.ts`   | Playbook YAML 执行引擎                  |
| `src/planes/orch/hitl-gate.ts`         | HITL 人工审批节点                       |
| `src/planes/orch/function-executor.ts` | Playbook step 函数执行器                |
| `src/interfaces/a2a/server.ts`         | Google A2A Server (robot-to-robot)      |
| `src/interfaces/a2a/client.ts`         | Google A2A Client                       |
| `src/interfaces/mcp/server.ts`         | MCP 工具暴露服务                        |
| `src/interfaces/connectors/opc-ua.ts`  | OPC-UA Connector（stdio child process） |
| `src/interfaces/connectors/modbus.ts`  | Modbus Connector                        |
| `src/interfaces/connectors/mqtt.ts`    | MQTT Connector                          |
| `src/interfaces/rest/router.ts`        | ClaWorks REST API 路由                  |
| `src/pack-loader/loader.ts`            | Pack 加载/验证/注册                     |
| `extensions/claworks-robot/index.ts`   | 主插件实现（注册所有 cw\_\* 工具）      |

---

## 二、Extensions 保留/删除策略

openclaw 有 90+ 个 extensions，ClaWorks 只需要其中的一个子集。

### 2.1 必须保留（ClaWorks 核心依赖）

| Extension                | 原因                                     |
| ------------------------ | ---------------------------------------- |
| `claworks-robot`         | ClaWorks 主插件（新建）                  |
| `feishu`                 | HITL 默认 IM 频道（中国企业首选）        |
| `telegram`               | HITL 备选 IM 频道                        |
| `discord`                | HITL 备选 IM 频道                        |
| `webhooks`               | 外部事件输入（OT/ERP webhook 触发器）    |
| `memory-core`            | KB 底层（知识库语义检索）                |
| `memory-lancedb`         | 向量存储后端                             |
| `skill-workshop`         | Skill 系统（Playbook step 可调用 Skill） |
| `openai`                 | LLM 决策节点默认模型                     |
| `anthropic`              | LLM 备选                                 |
| `ollama`                 | 本地/私有化部署 LLM                      |
| `file-transfer`          | 文档摄入到 KB                            |
| `document-extract`       | PDF/DOCX 解析                            |
| `diagnostics-prometheus` | 企业监控（Prometheus metrics）           |
| `diagnostics-otel`       | 链路追踪（OpenTelemetry）                |
| `qa-lab` / `qa-channel`  | 测试框架                                 |

### 2.2 按需保留（视客户场景）

| Extension                        | 场景                     |
| -------------------------------- | ------------------------ |
| `msteams`                        | 微软企业客户的 HITL 频道 |
| `slack`                          | 北美/欧洲企业 HITL 频道  |
| `google`                         | Google Workspace 集成    |
| `microsoft`                      | M365/Azure 集成          |
| `browser`                        | 需要网页抓取的场景       |
| `web-readability` / `web-fetch`  | 外部信息摄入             |
| `exa` / `tavily` / `brave`       | 网络搜索能力             |
| `litellm` / `openrouter`         | 多模型代理               |
| `qwen` / `deepseek` / `moonshot` | 国内 LLM 提供商          |

### 2.3 可以删除（不适合 ClaWorks 工业场景）

| Extension                           | 原因                            |
| ----------------------------------- | ------------------------------- |
| `imessage`                          | 消费级 IM，不用于企业           |
| `sms` / `phone-control`             | 消费级通信                      |
| `tlon`                              | 去中心化社交，非企业场景        |
| `nostr`                             | 区块链社交协议                  |
| `line` / `zalo` / `qqbot`           | 消费级 IM（除非有明确客户需求） |
| `twitch` / `youtube`                | 娱乐直播平台                    |
| `music-generation-*`                | 娱乐内容生成                    |
| `video-generation-*`                | 娱乐内容生成                    |
| `inworld`                           | 游戏 NPC，非企业                |
| `comfy`                             | ComfyUI 图像生成                |
| `migrate-claude` / `migrate-hermes` | 迁移工具，不对外                |

> **策略**：Phase 1 不删任何 extension，保持完整继承。Phase 2 开始时做一次清理，删除确认不需要的 extension，减小发布包体积。

---

## 三、配置文件改动

### 3.1 `src/config/` 默认值

| 配置键             | openclaw 默认 | claworks 改为                            |
| ------------------ | ------------- | ---------------------------------------- |
| `gateway.port`     | 任意          | `8000`（ClaWorks robot 标准端口）        |
| `plugins.defaults` | 多个 channel  | 仅保留 `claworks-robot` 作为默认激活插件 |

### 3.2 新增配置命名空间

```yaml
# claworks 新增的顶层配置节（通过 plugin-sdk 的 config-contracts 扩展）
claworks:
  robot:
    name: "my-robot" # 机器人名称（A2A Agent Card 用）
    role: monolith # monolith | twin | ops | nexus
    port: 8000
  packs:
    paths: # 本地 pack 搜索路径
      - ~/.claworks/packs
      - ./packs
    registry: https://nexus.claworks.ai # Nexus 注册中心
  data:
    database_url: "sqlite:///.claworks/data.db"
  a2a:
    enabled: true
    endpoint: http://0.0.0.0:8001
```

---

## 四、新增的 npm 依赖

在 `package.json` 中需要追加（不替换任何现有依赖）：

| 包                      | 用途                                         |
| ----------------------- | -------------------------------------------- |
| `drizzle-orm`           | ObjectStore ORM                              |
| `drizzle-kit`           | Schema 迁移工具                              |
| `better-sqlite3`        | 默认嵌入式 DB（生产可换 PostgreSQL）         |
| `@types/better-sqlite3` | 类型                                         |
| `js-yaml`               | Playbook/Pack YAML 解析（openclaw 可能已有） |
| `zod`                   | Pack manifest 运行时校验（openclaw 已有）    |
| `cron` 或 `node-cron`   | 定时触发器                                   |

---

## 五、Upstream Sync 纪律

每次从 `upstream/main` 合并前检查：

1. `src/kernel/`, `src/planes/`, `src/interfaces/` — **仅 ClaWorks 新增**，upstream 没有，不会冲突
2. `src/plugin-sdk/` — openclaw 可能更新，接受 upstream 版本
3. `extensions/claworks-robot/` — 仅 ClaWorks 有，不会冲突
4. `package.json` — `name/version/bin/description` 保持 claworks 版本，其余字段接受 upstream
5. `README.md` — 保持 claworks 版本

```bash
# 标准 upstream sync 流程
git fetch upstream
git merge upstream/main --no-edit
# 手动解决上述 5 类冲突
pnpm install
pnpm check:changed
```
