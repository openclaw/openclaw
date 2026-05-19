# ClaWorks 架构总纲

**版本**：v1.0  
**日期**：2026-05-19  
**状态**：设计基准，不再大改架构

---

## 一、产品定位

ClaWorks 是面向工业/企业场景的**自治机器人运行时框架**。

```
OpenClaw（官方，不改）          ClaWorks（本项目）
─────────────────────           ────────────────────────────
个人 AI 助理平台                企业自治机器人运行时
用户通过 IM 与 AI 对话          机器人自主响应业务事件
138 个 LLM Provider             PlaybookEngine + EventKernel
Skills 生态                     Extension Pack 生态

两者关系：
  OpenClaw ←→ ClaWorks 通过 openclaw-claworks-extension 插件对接
  用户用 OpenClaw IM 管理/操控 ClaWorks 机器人
  ClaWorks 机器人通过 A2A 互联，形成企业机器人网格
```

---

## 二、技术基础

ClaWorks 基于 OpenClaw 代码 Fork 开发（TypeScript/Node.js），保留：

- **src/gateway/** — 进程生命周期、Plugin 热重载、HTTP server
- **src/plugins/** — Plugin 注册/加载/合约体系（Extension Pack 基础）
- **src/agents/** — LLM runner、Skills、subagent、managedFlows
- **src/config/** — 配置热重载
- **src/cli/** — CLI 框架
- **src/acp/** — Agent Client Protocol（子 agent 通信）
- **extensions/openai、anthropic 等** — LLM Providers（PlaybookEngine 直接用）
- **extensions/feishu、telegram 等** — IM 渠道（HITL 通知）

新增（ClaWorks 独有）：

- **src/kernel/** — EventKernel（自治事件循环）
- **src/planes/data/** — ObjectStore、OntologyEngine、KnowledgeBase
- **src/planes/orch/** — PlaybookEngine、HITLGate、FunctionExecutor
- **src/interfaces/a2a/** — Google A2A Server（机器人互联）
- **src/interfaces/mcp/** — MCP Server（工具对外暴露）

---

## 三、仓库体系

```
/Users/power/Projects/
├── claworks/                        ← 本项目（OpenClaw Fork → ClaWorks 产品）
│   ├── src/                         ← 继承 OpenClaw src/ + 新增 kernel/planes/interfaces/
│   ├── extensions/                  ← 只保留 ClaWorks 自身需要的 extension
│   ├── packages/                    ← ClaWorks SDK + 工具包
│   └── docs/design/                 ← 本设计文档目录
│
├── openclaw-claworks-extension/     ← 独立仓库：官方 OpenClaw 用户通过此插件接入 ClaWorks
│   ├── extensions/claworks/         ← cw_* 工具（接入 ClaWorks HTTP/A2A）
│   └── packages/claworks-client/    ← HTTP transport、instance resolver
│
└── claworks-packs/                  ← 独立仓库：行业扩展包（可商业化）
    ├── base/                        ← 基础本体（开源）
    ├── process-industry/            ← 流程工业（开源或商业）
    └── oilgas/                      ← 油气行业（商业）
```

---

## 四、核心组件架构

### 4.1 运行时三平面

```
┌─────────────────────────────────────────────────────────┐
│                    ClaWorks Process                      │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │               OpenClaw Gateway（继承）            │   │
│  │  Plugin 加载 · HTTP Server · Config 热重载        │   │
│  │  LLM Providers · IM Channels · Skills · subagent │   │
│  └─────────────────────┬────────────────────────────┘   │
│                         │ registerService / registerTool  │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │              EventKernel（新增）                  │    │
│  │   EventBus · Scheduler · Outbox · Matcher        │    │
│  └──────┬───────────────┬────────────────┬──────────┘    │
│         │               │                │               │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐        │
│  │  DataPlane  │ │  OrchPlane  │ │  Interfaces │        │
│  │             │ │             │ │             │        │
│  │ ObjectStore │ │PlaybookEng. │ │  A2A Server │        │
│  │ Ontology    │ │ HITLGate    │ │  MCP Server │        │
│  │ KB (RAG)    │ │ FuncExec    │ │  REST API   │        │
│  └─────────────┘ └─────────────┘ └─────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### 4.2 EventKernel 事件流

```
外部事件源                 EventKernel              业务处理
────────────          ──────────────────         ───────────
OT Connector  ──►     EventBus.publish()  ──►    Matcher
IM 消息        ──►     (优先级队列)          │     PlaybookEngine.run()
A2A Task      ──►                          │     HITLGate (等待审批)
Cron 定时      ──►     Outbox (可靠投递)  ◄─┘     FunctionExecutor (LLM)
REST API      ──►     Scheduler
```

### 4.3 Extension Pack 体系（类比 OpenClaw Plugin）

```
OpenClaw Plugin              ClaWorks Extension Pack
─────────────────            ──────────────────────
definePluginEntry()    →     definePackEntry()
api.registerTool()     →     pack.registerObjectType()
api.registerService()  →     pack.registerPlaybook()
api.on(hook)           →     pack.registerConnector()
openclaw.plugin.json   →     claworks.pack.json
~/.openclaw/skills/    →     ~/.claworks/packs/
clawhub.ai             →     nexus.claworks.ai
```

---

## 五、多机器人 A2A 网格

```
                    企业 A2A 网格
                    
  [泵站机器人]  ◄──A2A──►  [管道机器人]  ◄──A2A──►  [调度机器人]
  本体：Pump              本体：Pipeline            本体：WorkOrder
  数据：实时读数           数据：流量/压力            数据：工单/班次
                                │
                       ┌────────▼────────┐
                       │  OpenClaw 用户   │
                       │  飞书/Telegram   │
                       │  （HITL 审批）   │
                       └─────────────────┘

每个机器人：
- 小而精的本体（单业务域，LLM 上下文不稀释）
- 通过 A2A 委托跨域决策给相邻机器人
- 通过 OpenClaw IM 接受人类审批

vs Palantir：
- Palantir：一个巨型本体，需要深度工业专家，6-18 个月实施
- ClaWorks：每个机器人独立部署，天级接入，LLM 理解业务
```

---

## 六、Nexus Pack 仓库

ClaWorks Nexus 参考 OpenClaw ClaWHub（`src/infra/clawhub.ts` 1075行）实现兼容 API：

```
claworks.pack.json                openclaw.plugin.json（参考）
──────────────────                ────────────────────────────
{                                 {
  "id": "process-industry",         "id": "feishu",
  "type": "claworks-pack",          "type": "channel",
  "version": "1.0.0",               "version": "2026.5.x",
  "provides": {                     "provides": ["channel"]
    "objectTypes": [...],         }
    "playbooks": [...],
    "connectors": [...]
  }
}

Nexus API（兼容 ClaWHub 形状）：
GET  /api/packages?family=claworks-pack
GET  /api/packages/{slug}
GET  /api/packages/{slug}/versions/{v}/artifacts
POST /api/packages/{slug}/install  (claworks nexus install)
```

---

## 七、爆点设计

ClaWorks 的核心价值主张（类比 OpenClaw 消除 App UI 开发）：

**"企业现有系统接入后，80% 的例行决策自动完成，剩下 20% 通过 IM 推给人类"**

三个杀手级触发场景：

1. **告警→工单自动闭环**：OT 设备告警 → PlaybookEngine → 自动创建工单 → 飞书通知 → 工程师确认
2. **HITL 审批零门槛**：重大决策机器人发飞书卡片，管理层点按钮即审批，无需登录专有系统
3. **知识库赋能新人**：设备故障 → KB 检索历史案例+手册 → LLM 给出处置建议，新人也能做专家决策

---

## 八、设计原则

1. **OpenClaw 核心不改** — 只在 Fork 基础上新增，确保 `git merge upstream/main` 低摩擦
2. **插件即一切** — EventKernel、DataPlane、OrchPlane 均以 `registerService` 形式挂载
3. **YAML 驱动** — 本体/Playbook/Connector 定义用 YAML，语言无关，生态友好
4. **渐进式部署** — 单机 monolith → twin+ops 分离 → 多机器人 A2A 网格
5. **护城河在数据** — 行业本体 YAML + Playbook 模板是真正的 IP，代码开源，数据商业化
