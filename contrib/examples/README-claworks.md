# ClaWorks 示例文件说明

**ClaWorks** 是一个面向工业场景的自主机器人运行时平台，基于事件驱动的 Playbook 编排、知识库、能力注册表和 A2A 对等协作体系，与 OpenClaw（个人 AI 侧车）深度集成。

---

## 主要能力

| 能力域                  | 说明                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| **EventKernel**         | 事件总线 + 幂等去重 + 速率限制 + CommandLane 6 路隔离队列               |
| **PlaybookEngine**      | YAML/JS 编排引擎，支持 LLM 步骤、HITL 审批、CBR 学习、定时调度          |
| **CapabilityRegistry**  | ~60 个核心能力 + Pack 扩展能力，行为准则四层保护                        |
| **KnowledgeBase**       | BM25 文本检索 + 文档分块 + 向量索引（memory-core/LanceDB 可选）         |
| **Pack 系统**           | YAML + JS 双模式，热加载，base/industrial/personal-enterprise 三套 Pack |
| **A2A 对等协作**        | 多机器人互信白名单 + 委派任务 + 消息路由                                |
| **AutonomyEngine**      | 心跳自检 + 接口发现 + 学习机会检测 + 自主进化 Playbook                  |
| **HookEngine**          | 事件主动推送（报警 → 飞书/企微/钉钉/Webhook）                           |
| **结构化输出引擎**      | 强制 LLM 返回 JSON schema，失败自动重试（弱模型补偿）                   |
| **规则引擎 + Skill 库** | if-then 规则 / 纯脚本原子能力，完全不依赖 LLM                           |

## 使用场景

- 工厂报警自动分拣 → 创建工单 → 通知值班员（HITL 确认）
- 巡检计划到期自动提醒 + 跨 A2A 机器人委派
- 飞书 IM 消息意图识别 + 多轮对话
- 环境变量扫描 + 服务发现 + 自我介绍
- 每日/班次报告自动生成推送

---

## 本目录文件

| 文件                                                    | 说明                                             |
| ------------------------------------------------------- | ------------------------------------------------ |
| `robot.md`                                              | 机器人宪法示例（行为准则、RBAC、HITL 规则）      |
| `robot-personal.md`                                     | 个人版机器人宪法（OpenClaw 个人 + 企业混合模式） |
| `claworks-production.openclaw.fragment.json`            | 生产部署 OpenClaw 片段配置                       |
| `claworks-personal-enterprise.openclaw.fragment.json`   | 个人企业混合 OpenClaw 片段配置                   |
| `claworks-personal.env.example`                         | 环境变量示例（个人部署）                         |
| `a2a-peer-mesh.openclaw.fragment.json`                  | A2A 双 Gateway 最小 peer 配置                    |
| `a2a-peer-mesh.zh.md`                                   | A2A 双机 walkthrough（中文）                     |
| `multi-instance-monolith-mfg.claworks.fragment.json`    | 多 monolith — 制造域 `claworks.json` 片段        |
| `multi-instance-monolith-supply.claworks.fragment.json` | 多 monolith — 供应链域片段                       |
| `multi-instance-twin-ops.claworks.fragment.json`        | 可选 twin/ops 1:1 拆分（双 `claworks.json`）     |
| `multi-instance.openclaw.bridge.fragment.json`          | OpenClaw 侧多实例 `cw_*` 桥接片段                |

多实例部署总览：[`docs/MULTI-INSTANCE-DEPLOYMENT.md`](../docs/MULTI-INSTANCE-DEPLOYMENT.md)。
| `playbooks/patrol_pending_runs_alert.yaml` | `robot.patrol` 巡逻积压告警示例 Playbook |

---

## 自主巡逻 Playbook 示例

Runtime 默认每 5 分钟发布 `robot.patrol` 事件（载荷含 `pending_runs`、`playbook_count`）。
将 `playbooks/patrol_pending_runs_alert.yaml` 复制到 Pack 的 `ontology/playbooks/` 后 reload，
即可在运行中 Playbook 超过阈值时推送通知并写入审计日志。

---

## 快速入门

详见：[`packages/claworks-runtime/QUICKSTART.md`](../packages/claworks-runtime/QUICKSTART.md)

```bash
# 1. 复制机器人配置
cp contrib/examples/claworks-personal.env.example .env

# 2. 配置 contrib/examples/robot.md → claworks.robot.json
#    或直接复制示例
cp packages/claworks-runtime/claworks.robot.json.example \
   packages/claworks-runtime/claworks.robot.json

# 3. 启动（在 packages/claworks-runtime 目录）
node dist/index.js
```

---

## 已验证的核心能力 ID（集成测试覆盖）

```
perceive.message      perceive.intent       health.check
kb.search             notify.dispatch       environment.scan_envvars
observe.robot_status  robot.identity        harness.detect_openclaw
swarm.list
```

所有能力均通过 `packages/claworks-runtime/src/claworks.integration.test.ts` 自动验证。
