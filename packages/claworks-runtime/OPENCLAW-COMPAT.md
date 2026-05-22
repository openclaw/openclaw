# ClaWorks × OpenClaw 兼容层说明

本文档说明 ClaWorks 与 OpenClaw 之间的集成关系，以及两套系统如何互补而非冲突。

---

## 1. Skill 共享（SkillLibrary + OpenClaw skillRun）

### 架构

```
Playbook step (kind: skill)
        │
        ▼
   1. SkillLibrary.get(skillId)
        │ found?
        ├── YES → SkillLibrary.execute()  [本地纯脚本，0依赖LLM]
        │
        └── NO → skillRun(skillId, params)  [OpenClaw bridge 注入]
                        │ configured?
                        ├── YES → OpenClaw skillRun 执行
                        └── NO  → { status: "stub", skillId }
```

### 说明

- **ClaWorks SkillLibrary** 是独立的本地库（`kernel/skill-library.ts`）。它存储纯脚本技能，完全不依赖 LLM，是弱模型补偿的核心。
- **OpenClaw skillRun** 通过 `runtime-bridge.ts` 注入，当 SkillLibrary 中找不到对应 Skill 时才调用。
- 两者共用同一个 Playbook `kind: skill` 步骤调用入口，互不冲突——ClaWorks 本地优先，OpenClaw 作为远程 fallback。
- **新增本地 Skill**：调用 `runtime.skillLibrary.register({ id, name, execute })` 即可，不需要修改 OpenClaw 配置。

---

## 2. 会话/Session 兼容

### 架构

```
用户消息
    │
    ├── OpenClaw Gateway层
    │       └── Session（用户 ↔ Bot）管理
    │               └── IM 消息转发到 ClaWorks plugin
    │
    └── ClaWorks ContextEngine
            └── sessionKey = userId + channelId 组合
                    └── 跨轮次业务上下文（设备、工单、报警等）
```

### 说明

- **OpenClaw Session** 管理对话层状态（轮次、token计数、LLM历史），位于 Gateway 层。
- **ClaWorks ContextEngine**（`kernel/context-engine.ts`）管理业务上下文，用 `sessionId`（用户+渠道组合）隔离，存储工业场景特有的上下文（当前设备ID、正在处理的工单等）。
- 两者互补：OpenClaw Session 负责"对话历史"，ClaWorks Context 负责"业务状态"。
- `sessionKey` 由 `claworks-robot/runtime-bridge.ts` 从 OpenClaw session 派生，确保两侧会话 ID 对齐。

---

## 3. 逻辑 Agent 兼容

### 架构

```
OpenClaw 逻辑 Agent（对话者抽象）
        │
        ├── IM 消息 → im-bridge.ts → ClaWorks EventKernel
        │
        └── A2A 协议 → /a2a/tasks/send → ClaWorks A2A 任务处理
```

### 说明

- **OpenClaw 逻辑 Agent** 是对话者的抽象层（用户、机器人、工具）。
- **ClaWorks** 通过 A2A 协议（`interfaces/a2a/`）与其他逻辑 Agent 通信——发送任务（`a2a.send_task`）、委托 Playbook（`a2a.delegate`）、发现对等体（`a2a.discover`）。
- 通过 IM Bridge（`claworks/im-bridge.ts`），OpenClaw Agent 发来的 IM 消息自动转化为 `im.message_received` 事件，触发对应 Playbook。
- **身份协商**：A2A 任务中携带 `metadata.request_identity: true` 时，ClaWorks 会返回本机器人的身份信息（由 `RobotIdentityManager` 提供）。

---

## 4. Karpathy 风格知识库

### 架构

```
外部文档/URL
      │
      ▼
kb.ingest_document  ──→  chunkDocument()  ──→  KnowledgeBase.ingest()
 (自动分块)                (500字/块)             (BM25 或 memory-core)
      │
      ▼
 KB 检索（BM25 全文 或 向量语义搜索）
      │
      ├── LLM 增强路径：kb.search → perceive.intent → LLM reasoning
      └── 规则路径：kb.search → rule.evaluate → 确定性回答
```

### 说明

- **ClaWorks KB 系统**（`planes/data/knowledge-base.ts`）完全兼容 Karpathy 风格的知识库构建方式：
  - 摄入文档 → **`kb.ingest`** / **`kb.ingest_document`**（长文档自动分块）
  - 分块索引 → 每块作为独立 BM25 文档（或 memory-core 向量块）
  - 检索 → **`kb.search`** 返回相关结果
- **`kb.ingest_document`** 是专为 Karpathy 风格设计的批量摄入接口：
  - 按段落/标题自动切分（默认 500 字/块）
  - 支持 `source` 字段标注来源
  - 返回 `chunks_created` 和 `total_chars` 统计
- **生产向量搜索**：设置 `data.kb_provider: "memory-core"` 后，自动切换为 LanceDB 向量存储（语义搜索），与 BM25 接口完全兼容，无需修改 Playbook。

---

## 5. 集成快速参考

| 场景                | 使用的接口                                     | 文件位置                              |
| ------------------- | ---------------------------------------------- | ------------------------------------- |
| 注入 LLM            | `runtime.bridges.register(BRIDGE_LLM, ...)`    | `claworks-robot/bridge.ts`            |
| 注入通知渠道        | `runtime.bridges.register(BRIDGE_NOTIFY, ...)` | `claworks-robot/bridge.ts`            |
| 注入 OpenClaw Skill | `opts.skillRun` 参数                           | `createClaworksRuntime(config, opts)` |
| 本地注册 Skill      | `runtime.skillLibrary.register(...)`           | `kernel/skill-library.ts`             |
| IM 消息→事件        | `im-bridge.ts`                                 | `claworks/im-bridge.ts`               |
| A2A 任务委托        | `a2a.delegate` 能力                            | `kernel/extension-capabilities.ts`    |
| KB 摄入（长文档）   | `kb.ingest_document` 能力                      | `kernel/core-capabilities.ts`         |
| 机器人身份          | `robot.identity` / `robot.whoami` 能力         | `kernel/core-capabilities.ts`         |
| 安全审计            | `security.audit_log` 能力                      | `kernel/extension-capabilities.ts`    |
