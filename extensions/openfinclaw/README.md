# @openfinclaw/openfinclaw

FinClaw Commons - 量化策略开发平台插件。连接 hub.openfinclaw.ai 策略网络，支持策略创建、验证、发布、Fork。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

或手动安装：

```bash
openclaw plugins install @openfinclaw/openfinclaw
```

## 功能概览

| 功能      | 工具/Skill             | 说明                         |
| --------- | ---------------------- | ---------------------------- |
| 策略创建  | `fin-strategy-builder` | 自然语言生成 FEP v1.2 策略包 |
| 策略验证  | `skill_validate`       | 本地验证策略包格式           |
| 策略发布  | `skill_publish`        | 发布到 Hub 并自动回测        |
| 发布查询  | `skill_publish_verify` | 查询发布和回测状态           |
| 策略 Fork | `skill_fork`           | 从 Hub 下载策略到本地        |
| 本地列表  | `skill_list_local`     | 列出本地已下载的策略         |
| 策略详情  | `skill_get_info`       | 获取 Hub 策略详情            |

### AI 工具列表

| 工具                   | 说明                              |
| ---------------------- | --------------------------------- |
| `skill_publish`        | 发布策略 ZIP 到 Hub，自动触发回测 |
| `skill_publish_verify` | 查询发布状态和回测报告            |
| `skill_validate`       | 本地验证策略包（FEP v1.2）        |
| `skill_fork`           | 从 Hub 下载策略到本地             |
| `skill_list_local`     | 列出本地策略                      |
| `skill_get_info`       | 获取 Hub 策略详情                 |

## CLI 命令

```bash
# 从 Hub Fork 策略
openfinclaw strategy fork <strategy-id>

# 列出本地策略
openfinclaw strategy list

# 查看策略详情
openfinclaw strategy show <name-or-id> [--remote]

# 删除本地策略
openfinclaw strategy remove <name-or-id> --force
```

## 配置

安装后配置 API Key（从 https://hub.openfinclaw.ai 获取）：

```bash
openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_API_KEY
```

或使用环境变量：

```bash
export SKILL_API_KEY=YOUR_API_KEY
export SKILL_API_URL=https://hub.openfinclaw.ai
```

### ⚠️ API Key 安全提醒

**重要：请勿泄露你的 Hub API Key！**

- API Key 以 `fch_` 开头，**仅用于** hub.openfinclaw.ai 接口校验
- **不要**将 API Key 提交到 Git 仓库或公开分享
- **不要**在公开聊天、截图、代码示例中暴露真实的 API Key
- 如果怀疑 Key 已泄露，请立即在 Hub 个人设置中重新生成

### 配置选项

| 配置项             | 环境变量                   | 说明         | 默认值                       |
| ------------------ | -------------------------- | ------------ | ---------------------------- |
| `skillApiKey`      | `SKILL_API_KEY`            | Hub API Key  | 必填                         |
| `skillApiUrl`      | `SKILL_API_URL`            | Hub 服务地址 | `https://hub.openfinclaw.ai` |
| `requestTimeoutMs` | `SKILL_REQUEST_TIMEOUT_MS` | 请求超时     | `60000`                      |

## Skills

### openfinclaw (入口)

平台入口 skill，帮助用户了解 Hub 平台、安装插件、使用工具链。

### skill-publish

发布策略到 Hub：

```
用户: "发布我的策略到服务器"
Agent:
1. skill_validate(dirPath) → 本地验证
2. [打包 ZIP]
3. skill_publish(filePath) → 获取 submissionId
4. skill_publish_verify(submissionId) → 轮询直到完成
5. 返回回测报告
```

### fin-strategy-builder

自然语言生成策略：

```
用户: "帮我创建一个 BTC 定投策略，每周买入 100 美元"
Agent:
1. 生成 fep.yaml 配置
2. 生成 scripts/strategy.py 代码
3. 可选：验证并打包
```

### strategy-fork

从 Hub 下载策略：

```
用户: "帮我下载那个收益 453% 的 BTC 策略"
Agent:
1. skill_get_info(strategyId) → 查看详情
2. skill_fork(strategyId) → 下载到本地
3. 返回本地路径供编辑
```

## 本地存储

策略存储在 `~/.openfinclaw/strategies/`：

```
~/.openfinclaw/strategies/
└── 2026-03-16/
    ├── btc-adaptive-dca-34a5792f/   # Fork 来的策略
    │   ├── fep.yaml
    │   ├── scripts/strategy.py
    │   └── .fork-meta.json
    └── my-new-strategy/             # 自建策略
        └── ...
```

## 链接

- **Hub 平台**: https://hub.openfinclaw.ai
- **排行榜**: https://hub.openfinclaw.ai/leaderboard
- **获取 API Key**: https://hub.openfinclaw.ai/dashboard
- **GitHub**: https://github.com/cryptoSUN2049/openFinclaw

## License

MIT
