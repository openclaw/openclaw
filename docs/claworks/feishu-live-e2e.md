# Feishu Live E2E Runbook

> 预生产 / 签收：验证飞书 IM 消息经 Gateway ingress 进入 ClaWorks 事件链。  
> **无凭证时**：CI 跑 gate 单测；本地 `pnpm claworks:feishu:live-e2e` 自动 SKIP。

---

## 1. 环境变量

复制 [`contrib/examples/feishu-live-e2e.env.example`](../../contrib/examples/feishu-live-e2e.env.example)：

| 变量                   | 说明                                          |
| ---------------------- | --------------------------------------------- |
| `FEISHU_APP_ID`        | 飞书应用 App ID                               |
| `FEISHU_APP_SECRET`    | 飞书应用 Secret                               |
| `FEISHU_TEST_CHAT_ID`  | 探针群聊 `oc_xxx`（与 open_id 二选一）        |
| `FEISHU_TEST_OPEN_ID`  | 探针用户 open_id                              |
| `CLAWORKS_GATEWAY_URL` | Gateway 基址（默认 `http://127.0.0.1:18800`） |

```bash
set -a; source contrib/examples/feishu-live-e2e.env; set +a
```

---

## 2. 分层验证

### 2.1 CI / 无凭证（gate 单测）

```bash
pnpm test test/scripts/claworks-feishu-live-e2e-gate.test.ts
```

Workflow：`.github/workflows/claworks-smoke.yml` 在 PR 路径包含 gate 测试。

### 2.2 进程内 ingress（smoke 子集）

`pnpm claworks:smoke` 内 `claworks-http-smoke.mjs` / `claworks-e2e-smoke.mjs` 已向 `/v1/events` POST feishu channel 载荷（无需飞书 API）。

### 2.3 Live 探针（需凭证 + 运行中 Gateway）

```bash
pnpm claworks:gateway   # 或 LaunchAgent
pnpm claworks:feishu:live-e2e
```

脚本行为：

1. `evaluateFeishuLiveE2eGate` — 缺凭证则 **SKIP 0**
2. `GET /v1/health` — Gateway 可达
3. `POST /v1/events` — `buildFeishuIngressPayload` 注入 `im.message.received`
4. 日志提示检查 Gateway / 飞书会话回复

**完整回环**（飞书 API 发消息 + webhook 入站 + 卡片读回）需 OpenClaw `feishu` 渠道 + 公网 webhook URL — 见 [`docs/OBSERVABILITY.md`](../OBSERVABILITY.md)。

---

## 3. Ingress 载荷契约

Gate helper：`scripts/lib/claworks-feishu-live-e2e-gate.mjs`

- Header：`X-ClaWorks-Channel-User: feishu:<open_id>`
- Body：`payload.channel=feishu`，`payload.text` 为探针文本

单测覆盖 skip 逻辑与 payload 形状。

---

## 4. 故障排查

| 现象                   | 检查                                                      |
| ---------------------- | --------------------------------------------------------- |
| SKIP                   | 设置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` + chat/open_id |
| Gateway unhealthy      | `pnpm claworks:gateway` / 端口 18800                      |
| `/v1/events` 4xx       | Gateway 日志；robot 插件是否加载                          |
| ingress 绿、无飞书回复 | 需 feishu 渠道 + webhook；live 脚本仅验 ingress           |

相关：[`install.md`](install.md) · [`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md)
