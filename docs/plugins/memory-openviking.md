---
summary: "Memory OpenViking plugin: production setup, configuration, validation, and troubleshooting (English + Chinese)"
read_when:
  - You are deploying OpenViking-backed memory in production
  - You need a customer-facing runbook for memory-openviking
title: "Memory OpenViking Plugin"
---

# Memory OpenViking Plugin

This page is a release runbook for deploying and operating the `memory-openviking` plugin in production.

## English

### Scope

Use this guide when you want OpenClaw to:

- Automatically capture user memory from conversations (`autoCapture`)
- Automatically inject relevant memory before answering (`autoRecall`)
- Expose memory tools (`memory_store`, `memory_recall`, `memory_forget`)

### Prerequisites

- OpenClaw installed and reachable from your runtime host
- OpenViking service running and reachable from OpenClaw
- A model provider key for your agent runtime
- OpenViking API key (if OpenViking auth is enabled)

### One-time setup

1. Install and enable the plugin.

```bash
openclaw plugins install @openclaw/memory-openviking
openclaw plugins enable memory-openviking
openclaw config set plugins.slots.memory memory-openviking
```

2. Configure the plugin (recommended: secret via env var).

```bash
openclaw config set plugins.entries.memory-openviking.config.baseUrl "http://127.0.0.1:1933"
openclaw config set plugins.entries.memory-openviking.config.apiKey '${OPENVIKING_API_KEY}'
openclaw config set plugins.entries.memory-openviking.config.targetUri "viking://user/memories"
openclaw config set plugins.entries.memory-openviking.config.autoCapture true --json
openclaw config set plugins.entries.memory-openviking.config.autoRecall true --json
openclaw config set plugins.entries.memory-openviking.config.recallLimit 6 --json
openclaw config set plugins.entries.memory-openviking.config.recallScoreThreshold 0.01 --json
```

3. Validate effective config.

```bash
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-openviking.config --json
```

4. Restart the OpenClaw runtime/gateway process after config edits.

### Recommended production values

- `baseUrl`: internal service URL for OpenViking (stable DNS/port)
- `apiKey`: `${OPENVIKING_API_KEY}` (avoid plaintext secrets)
- `targetUri`: `viking://user/memories`
- `autoCapture`: `true`
- `autoRecall`: `true`
- `recallLimit`: `6` (raise only if prompt budget allows)
- `recallScoreThreshold`: `0.01` (tune higher if recall is noisy)
- `timeoutMs`: `15000` (raise if network is slow)

### Runtime verification (smoke test)

1. Store a memory through OpenClaw.

```bash
OPENVIKING_API_KEY="<your-openviking-key>" \
openclaw agent --local --json --session-id e2e-openviking \
  --message 'Please call only memory_store and save: I like red flowers and prioritize red when buying flowers.'
```

2. Search directly in OpenViking to confirm persistence.

```bash
curl -sS -X POST http://127.0.0.1:1933/api/v1/search/search \
  -H "X-API-Key: <your-openviking-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"red flowers prioritize buying","target_uri":"viking://user/memories","limit":20,"score_threshold":0}'
```

3. Validate recall injection on the next turn.

```bash
OPENVIKING_API_KEY="<your-openviking-key>" \
openclaw agent --local --json --session-id e2e-openviking \
  --message 'When buying flowers, which color should I prioritize?'
```

Expected behavior:

- The plugin logs auto-recall/auto-capture events
- OpenViking search returns leaf memories under `viking://user/memories/preferences/...`

### Daily operations (minimal)

- Check OpenViking health (`/health`)
- Keep OpenClaw and OpenViking running as managed services
- Monitor logs for:
  - `Invalid API Key`
  - `fetch failed`
  - plugin load errors

### Troubleshooting

- `plugin not found: memory-openviking`
  - Re-run install/enable and confirm `plugins.slots.memory`.
- `OpenViking request failed [UNAUTHENTICATED]: Invalid API Key`
  - OpenClaw plugin key and OpenViking server key do not match.
- `fetch failed`
  - OpenViking is down, wrong `baseUrl`, wrong port, or blocked network path.
- Search returns empty
  - Confirm `autoCapture=true`, run a message with capture triggers, then query with `score_threshold: 0`.
- JSON request validation error in curl
  - Ensure JSON uses standard double quotes (`"`), not smart quotes.

---

## 中文版

### 适用范围

当你希望 OpenClaw 具备以下能力时使用本指南：

- 会话中自动抽取用户长期记忆（`autoCapture`）
- 回答前自动召回相关记忆注入上下文（`autoRecall`）
- 使用记忆工具（`memory_store`、`memory_recall`、`memory_forget`）

### 前置条件

- OpenClaw 已安装并可运行
- OpenViking 服务已启动，且 OpenClaw 可访问
- Agent 模型可用的 API Key
- OpenViking API Key（如果服务开启鉴权）

### 一次性初始化配置

1. 安装并启用插件。

```bash
openclaw plugins install @openclaw/memory-openviking
openclaw plugins enable memory-openviking
openclaw config set plugins.slots.memory memory-openviking
```

2. 配置插件（建议密钥走环境变量）。

```bash
openclaw config set plugins.entries.memory-openviking.config.baseUrl "http://127.0.0.1:1933"
openclaw config set plugins.entries.memory-openviking.config.apiKey '${OPENVIKING_API_KEY}'
openclaw config set plugins.entries.memory-openviking.config.targetUri "viking://user/memories"
openclaw config set plugins.entries.memory-openviking.config.autoCapture true --json
openclaw config set plugins.entries.memory-openviking.config.autoRecall true --json
openclaw config set plugins.entries.memory-openviking.config.recallLimit 6 --json
openclaw config set plugins.entries.memory-openviking.config.recallScoreThreshold 0.01 --json
```

3. 校验生效配置。

```bash
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-openviking.config --json
```

4. 配置变更后，重启 OpenClaw 运行进程（Gateway 或等价进程）。

### 生产推荐参数

- `baseUrl`: OpenViking 内网地址（稳定域名/端口）
- `apiKey`: `${OPENVIKING_API_KEY}`（避免明文）
- `targetUri`: `viking://user/memories`
- `autoCapture`: `true`
- `autoRecall`: `true`
- `recallLimit`: `6`（提示词预算紧张时不要设置过大）
- `recallScoreThreshold`: `0.01`（召回噪声大时可调高）
- `timeoutMs`: `15000`（网络慢可适当增大）

### 运行验收（冒烟）

1. 通过 OpenClaw 写入记忆。

```bash
OPENVIKING_API_KEY="<your-openviking-key>" \
openclaw agent --local --json --session-id e2e-openviking \
  --message '请只调用 memory_store 保存：我喜欢红色花朵，买花时优先红色。'
```

2. 直接查询 OpenViking 验证入库。

```bash
curl -sS -X POST http://127.0.0.1:1933/api/v1/search/search \
  -H "X-API-Key: <your-openviking-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"红色 花朵 买花 优先","target_uri":"viking://user/memories","limit":20,"score_threshold":0}'
```

3. 下一轮会话验证召回。

```bash
OPENVIKING_API_KEY="<your-openviking-key>" \
openclaw agent --local --json --session-id e2e-openviking \
  --message '我买花时该优先选什么颜色？'
```

预期结果：

- 日志中能看到 auto-recall/auto-capture 相关输出
- OpenViking 查询能返回 `viking://user/memories/preferences/...` 下的叶子记忆

### 日常运维最小流程

- 健康检查：`/health`
- OpenClaw/OpenViking 均由进程托管方式常驻
- 重点关注日志：
  - `Invalid API Key`
  - `fetch failed`
  - 插件加载失败

### 常见问题

- `plugin not found: memory-openviking`
  - 重新执行 install/enable，并确认 `plugins.slots.memory`。
- `OpenViking request failed [UNAUTHENTICATED]: Invalid API Key`
  - OpenClaw 插件配置的 key 与 OpenViking 启动 key 不一致。
- `fetch failed`
  - OpenViking 未启动，或 `baseUrl`/端口错误，或网络不可达。
- 查不到数据
  - 确认 `autoCapture=true`，发送包含触发词的用户消息，再用 `score_threshold: 0` 查询。
- curl 参数校验报错
  - 检查 JSON 引号是否为标准英文双引号 `"`，不要使用中文引号。
