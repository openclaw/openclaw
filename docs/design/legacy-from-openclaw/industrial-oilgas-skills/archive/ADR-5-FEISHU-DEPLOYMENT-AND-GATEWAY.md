# ADR-5：飞书私有化部署 & OpenClaw 网关架构

## 架构决策记录

**日期**：2026-05-08  
**状态**：决策已定  
**问题**：私有飞书版本对接兼容性、100用户=100个OpenClaw误解、是否需要网关、运维复杂度

> **⚠️ 键名勘误**：本文档中出现的 `FEISHU_BASE_URL` / `FEISHU_BOT_APP_ID` 已更名为
> `FEISHU_SERVER_URL` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。
> 权威配置见 `MODULE-DESIGN-PLATFORM.md §十三.3`（FeishuClient）和 §六（config.py）。

---

## 一、必须纠正的根本误解

### ❌ 错误模型（之前的描述产生了歧义）

```
错误理解：
  用户A → 自己的 OpenClaw 实例A
  用户B → 自己的 OpenClaw 实例B
  用户C → 自己的 OpenClaw 实例C
  ... 100个用户 → 100个 OpenClaw 实例 （运维噩梦）
```

### ✅ 正确模型

```
OpenClaw 是「团队/场站」粒度部署，不是「用户」粒度部署

一个场站（10-30人）→ 1个 OpenClaw Gateway 实例
  · 所有用户共用同一个 Gateway
  · 用户身份通过飞书 open_id 区分（OpenClaw 已原生支持）
  · Skills 在 Gateway 级别安装和配置
  · 每个用户的对话历史相互隔离（Session 级别）

类比：
  OpenClaw Gateway ≈ 公司的企业微信服务器
  不是每个员工自己有一台服务器
  而是公司有一台，所有员工连同一台
```

---

## 二、飞书私有化部署——不是障碍，反而更简单

### 2.1 飞书私有化 vs 公有云对比

```
维度              公有云飞书                    私有化飞书（企业自建）
─────────────────────────────────────────────────────────────────────
Bot API 地址      open.feishu.cn/open-apis/*    内网 feishu.company.com/open-apis/*
Webhook 回调      Platform需要公网IP/ngrok       Platform 直接用内网IP（更简单！）
API 兼容性        最新版本                       取决于私有化版本号（可能滞后1-2年）
网络拓扑          互联网中转                     全程内网（更安全，更快）
消息路由路径      用户→公网飞书→OpenClaw         用户→内网飞书→OpenClaw
SSL证书要求       飞书要求HTTPS                  内网自签证书即可
```

### 2.2 私有飞书的 API 版本风险及应对

```
风险：私有化飞书版本可能是 V3.x，公有云已到 V5.x
    某些新 API（如卡片 v2、视频消息、高级权限）私有化版本可能不支持

应对策略（按优先级）：

① 开工前确认客户飞书版本号（运维/IT部门提供）
  命令：curl https://feishu.company.com/healthz 查看版本信息
  或要求客户提供：「飞书管理后台 → 关于」中的版本号

② 使用保守 API（V3 兼容子集）：
  · 文本消息（im.v1.message.create）：所有版本支持
  · 卡片消息（interactive card）：V3.30+，大多数私有化版本支持
  · 图片/文件：V3.x 支持
  · 避免：语音消息转写 API（私有化版本通常不支持）

③ 抽象 FeishuAdapter 接口：
  Platform 的 FeishuClient 通过统一接口发消息
  底层可以切换不同 API 实现（私有化兼容模式/公有云完整模式）

④ 降级处理：
  如果卡片消息不支持 → 降级为文本消息 + 链接
  「请访问 https://clawtwin.company.com/workorder/WO-001 进行审批」
  （浏览器端完成 HITL，不依赖飞书卡片按钮）
```

### 2.3 私有飞书 Webhook 的网络路径（内网更简单）

```
私有飞书部署场景（典型石油管道企业）：

  ┌─────────────────────────────────────────────────────────────┐
  │                     企业内网                                 │
  │                                                             │
  │  员工手机/PC（飞书App）                                       │
  │       │                                                     │
  │       ▼                                                     │
  │  飞书私有化服务器（feishu.company.com）                       │
  │       │                                                     │
  │       ├──► OpenClaw Gateway（clawtwin-oc.company.com:3000）  │
  │       │    回调 URL：http://clawtwin-oc.company.com:3000/...  │
  │       │                                                     │
  │       └──► Platform API（clawtwin.company.com:8080）         │
  │            Webhook：http://clawtwin.company.com:8080/v1/... │
  │                                                             │
  │  全程内网，不需要 ngrok，不需要公网IP，不需要SSL证书          │
  └─────────────────────────────────────────────────────────────┘

开发环境（公有云飞书）：
  用 ngrok 临时暴露本地端口（ngrok http 8080）
  生产环境私有飞书不需要 ngrok
```

---

## 三、正确的多场站部署架构

### 3.1 典型石油管道公司（100个用户，10个场站）

```
部署规模假设：
  · 总用户：100人（分布在10个场站）
  · 每站：10人（操作员、主管、工程师）
  · 场站地理位置：分散（内蒙、四川、陕西等）
  · 网络：场站之间有专线/VPN连通

方案 A：集中式部署（推荐，先做这个）
─────────────────────────────────────────────
  总部/云端：
    1个 OpenClaw Gateway（所有人共用）
    1个 Platform API（或 Platform 集群）
    共享 Milvus / PostgreSQL / Kafka

  各场站：
    1个 opcua-bridge（连接本站 OPC-UA）
    1个 Ditto 实例（或共享 Ditto，按 station_id 隔离）
    本地网络传感器数据

  好处：
    · 运维简单（只维护1套 OpenClaw）
    · Skills 更新一次，所有用户立即生效
    · 知识库集中，跨站知识共享
  问题：
    · 需要场站到总部的稳定网络连接
    · 网络中断时 AI 对话不可用（数据采集不受影响，有本地 Ditto）

方案 B：按站部署（适合网络不稳定或数据合规要求严格的场景）
─────────────────────────────────────────────────────────
  每站部署：
    1个 OpenClaw Gateway（仅服务本站10人）
    1个 Platform API（本站数据）
    1个 Milvus（含本站知识）

  总部：
    1个 OpenClaw Manager（管理各站 OpenClaw，推送 Skill 更新）
    1个 知识库主节点（向各站同步 L0/L1 通用知识）

  好处：
    · 网络中断时本站 AI 仍可运行
    · 数据不出站（合规）
  问题：
    · 10个场站 = 10个 OpenClaw 实例（维护成本高）
    · Skills 更新需要推到10个实例
    · 需要 OpenClaw Manager 管理层

决策：Phase A 先做集中式（方案A）
      如果客户有合规或网络要求，Phase B 再做方案B
```

### 3.2 集中式部署的完整架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       企业总部（或私有云）                                 │
│                                                                          │
│  ┌─────────────────────┐    ┌────────────────────────────────────────┐   │
│  │  OpenClaw Gateway   │    │      ClawTwin Platform                 │   │
│  │  （1个实例，服务     │    │                                        │   │
│  │   全公司100用户）    │    │  Platform API :8080                    │   │
│  │                     │    │  ├── /v1/objects/*   Ontology           │   │
│  │  Feishu Channel  ◄──┼────┼──    /v1/tools/*     工具               │   │
│  │  industrial-twin    │    │  ├── /v1/feishu/webhook  ← 飞书回调     │   │
│  │  industrial-kb      │    │  └── /v1/ingest/*    知识摄入            │   │
│  │  industrial-workorder│   │                                        │   │
│  │  industrial-analytics│   │  Platform Scheduler (APScheduler)      │   │
│  │                     │    │  Platform HITL FSM                     │   │
│  │  用户身份识别：       │    │                                        │   │
│  │  feishu_open_id     │    │  FeishuClient → 飞书私有化服务器         │   │
│  │  → 查 Platform      │    │                                        │   │
│  │    user registry    │    │  PostgreSQL / Milvus / MinIO           │   │
│  │  → 确定有权访问      │    │  Ditto / Kafka / Redis                 │   │
│  │    哪些 station_id  │    │                                        │   │
│  └─────────────────────┘    └────────────────────────────────────────┘   │
│           │ API调用                    ▲ opcua数据推送                     │
└───────────┼────────────────────────────┼─────────────────────────────────┘
            │ 企业专线/VPN               │
            │                           │
┌───────────┴───────────────────────────┴─────────────────────────────────┐
│                         各场站（N个）                                     │
│                                                                          │
│  飞书私有化服务器  ←→  员工Feishu App（手机/PC）                           │
│       │                                                                  │
│       └──► HTTP → 总部 OpenClaw Gateway（企业专线）                       │
│                                                                          │
│  opcua-bridge（Python）                                                  │
│   ├── 连接本站 OPC-UA 服务器（现场设备数据）                               │
│   └── 推送到总部 Kafka → 总部 Ditto（按 station_id 隔离）                 │
│                                                                          │
│  ClawTwin Studio（浏览器，站内工程师用）                                   │
│   └── 访问总部 Platform API                                               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 四、是否需要"网关"——明确定义

"网关"这个词在这个架构里出现在 3 个不同的地方，需要区分：

### 4.1 OpenClaw Gateway（已有，这就是 OpenClaw 本身）

```
是什么：
  OpenClaw 的核心运行时，叫做 Gateway
  不是我们开发的，是 OpenClaw 产品自带的

做什么：
  · 接收用户消息（通过 Feishu Channel 等）
  · 管理 Agent 会话（每个用户的对话上下文）
  · 调用 Skills（industrial-twin/kb/workorder/analytics）
  · Skills 通过 Tool API 调用 Platform
  · 把 Agent 回复发回给用户

部署：1个实例服务整个公司（集中式方案）
维护：升级 OpenClaw 版本，更新 Skills 定义
```

### 4.2 Platform API Gateway（需要我们部署，Nginx）

```
是什么：
  Nginx 反向代理，Platform 服务的统一入口

做什么：
  · SSL 终止（HTTPS → HTTP 到后端）
  · 请求路由（/v1/objects → platform-api）
  · 速率限制（防止 OpenClaw 消息风暴）
  · API Key / JWT 验证（第一道鉴权）
  · 飞书 Webhook 路由（/v1/feishu/webhook → platform-api）

这是标准的微服务网关，不是新概念
Phase A 用 FastAPI 直接暴露（简单），Platform B 加 Nginx
```

### 4.3 "是否需要单独的消息路由网关"（用户的真实问题）

```
问题场景：
  私有飞书收到用户消息 → 需要转发给 OpenClaw
  如果 OpenClaw 是1个实例：飞书直接回调 OpenClaw → 没问题
  如果 OpenClaw 有多个实例（按站部署）：飞书不知道该发给哪个实例

所以：
  集中式方案（1个 OpenClaw）→ 不需要额外消息路由网关
  按站部署方案（N个 OpenClaw）→ 需要「OpenClaw 路由层」

如果选按站部署，路由逻辑：
  飞书 Bot 回调 → 路由服务（查 user → station → OpenClaw URL）→ 转发

  实现：
    platform-api 增加 /v1/feishu/route 端点
    或者用 OpenClaw 企业版的 multi-gateway 功能（如果有）
    或者每站注册独立的飞书 Bot App（最简单但管理复杂）

结论：Phase A 集中式，不需要消息路由网关
```

---

## 五、运维复杂度分析

### 5.1 集中式方案（推荐）的运维成本

```
需要维护的组件：
  总部：
    OpenClaw Gateway × 1    → 升级：pnpm update; restart
    Platform API × 1         → 升级：docker compose pull; up
    基础设施（DB/Kafka/...）  → 升级：docker compose pull
    Nginx × 1               → 配置变更

  各站（N个场站）：
    opcua-bridge × N        → 连接本站设备，配置改动少
    （无 OpenClaw，无 Platform）

更新 Skills（最常见操作）：
  只需在总部 OpenClaw Gateway 更新 Skills 文件
  → 所有用户立即生效（重启一次 OpenClaw）
  → 不需要去每个场站操作

用户管理：
  Platform Admin UI → 新建用户 → 分配 station_id + 角色
  OpenClaw 用户管理 → 用飞书 open_id 绑定 Platform 用户
```

### 5.2 知识 Skills 的安装和用户感知

```
用户不需要"安装 Skills"——Skills 是服务端配置，用户无感知

正确理解：
  Skills 是 OpenClaw Gateway 的配置文件（SKILL.md + 工具注册）
  运维人员部署好后，所有连接到这个 Gateway 的用户都自动获得能力

类比：
  用户不需要"安装公司的审批流程"
  IT 配置好了，用户打开飞书就能审批

Skills 配置路径（示例）：
  ~/.openclaw/agents/<orgAgentId>/skills/
    industrial-twin/SKILL.md       ← 安装
    industrial-kb/SKILL.md         ← 安装
    industrial-workorder/SKILL.md  ← 安装
    industrial-analytics/SKILL.md  ← 安装
```

### 5.3 如果客户有合规要求（数据不出站）

```
场景：某些央企场站，工单数据不能传输到总部

解决方案：
  数据分层：
    · L0/L1 通用知识（行业标准、设备手册）→ 集中存，定期同步到各站
    · L2 企业知识（内部规程）→ 各站独立存，不跨站
    · L3 场站知识（工单、操作记录）→ 场站本地，绝不出站
    · 实时数据（OPC-UA）→ 永远只在场站本地处理

  架构调整：
    Platform 实例：场站级（L2/L3 + 实时数据）+ 总部级（L0/L1 + 汇聚报表）
    OpenClaw：场站级（处理本站业务，调本站 Platform）
    Studio：可访问总部汇聚报表（合规范围内的统计数据）

  这就是「按站部署」方案，Phase B 实现
```

---

## 六、Phase A 确定采用的部署模型

### 决策：集中式，单站 demo

```
Phase A 部署（开发/Demo 阶段）：
  1台开发机（Mac）运行：
    · OpenClaw Gateway（本地，1个实例）
    · Platform API（docker-compose）
    · 所有基础设施（docker-compose）
    · ClawTwin Studio（vite dev server）

  飞书对接：
    · 公有云飞书（测试账号）
    · ngrok 暴露本地端口给飞书回调
    · 1个飞书 Bot App（OpenClaw + Platform 共用，Phase A 简化）

  用户：
    · 5-10 个测试账号（开发团队成员）
    · 全部连同一个 OpenClaw Gateway（共享，无需多实例）

Phase B 部署（客户现场）：
  确认客户飞书类型（公有/私有）→ 调整 API 基础 URL
  集中式优先，如有合规要求切换按站模式
  OpenClaw Manager（如果多站）→ 待 OpenClaw 企业版功能确认
```

---

## 七、飞书私有化版本对接的标准流程（工程交付物）

这是给客户现场工程师的操作手册提纲：

```
1. 确认版本
   客户提供：飞书私有化版本号（如 V3.45.0）
   我们确认：目标 API 是否在此版本支持
   工具：对照飞书私有化 changelog（需向飞书商务索取）

2. 配置 Bot App（在客户飞书管理后台）
   · 创建企业自建应用（非商店应用）
   · 开通权限：im:message, im:message:send_as_bot
   · 配置事件订阅 URL → http://[platform-intranet-ip]:8080/v1/feishu/webhook
   · 配置 Bot 消息事件 URL → http://[openclaw-intranet-ip]:3000/feishu/event

3. 填写配置（.env）
   FEISHU_BASE_URL=http://feishu.company.com   ← 私有化地址（关键！）
   FEISHU_BOT_APP_ID=xxx
   FEISHU_BOT_APP_SECRET=xxx
   FEISHU_DUTY_CHAT_ID=xxx

4. FeishuClient 适配（Platform 代码）
   # services/feishu.py 中：
   BASE_URL = os.getenv("FEISHU_BASE_URL", "https://open.feishu.cn")
   # 所有 API 调用用 BASE_URL 拼接，自动适配私有化
   token_url = f"{BASE_URL}/open-apis/auth/v3/tenant_access_token/internal"
   send_url  = f"{BASE_URL}/open-apis/im/v1/messages"

5. 测试
   发一条测试消息 → 确认 Bot 能收到 → 确认能回复
   触发一个 mock 告警 → 确认飞书卡片能到达群 → 确认点按钮能回调
```

---

## 八、结论三句话

```
1. OpenClaw 是「团队粒度」不是「用户粒度」：
   100个用户 ≠ 100个 OpenClaw
   10个场站，集中式 = 1个 OpenClaw，按站部署 = 10个 OpenClaw
   Phase A 先做集中式，1个 OpenClaw，运维最简单

2. 私有飞书反而更简单：
   全程内网，不需要 ngrok，不需要公网 IP
   API 只需改 BASE_URL，代码层面一个环境变量搞定
   版本兼容风险：开工前确认版本号，使用保守 API 子集

3. 网关是什么：
   OpenClaw Gateway = OpenClaw 本身（已有）
   Platform API Gateway = Nginx（Phase B 加，Phase A 直接暴露 FastAPI）
   消息路由网关 = 集中式方案不需要，按站方案 Phase B 再设计
```
