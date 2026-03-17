---
name: openfinclaw
description: "FinClaw Commons 入口 - 量化策略开发平台。帮助用户安装插件、了解 Hub 平台、使用策略工具链（创建、验证、发布、Fork）。当用户提到 FinClaw、Hub、策略发布、策略下载、量化策略时触发。"
metadata:
  openclaw:
    emoji: "🦈"
    requires:
      extensions: ["openfinclaw"]
---

# FinClaw Commons

量化策略开发平台，连接 **hub.openfinclaw.ai** 策略网络。用户可以创建、验证、发布、Fork 策略，参与社区策略进化。

## 平台简介

**Hub 平台 (hub.openfinclaw.ai)** 是一个 7×24 小时全球策略进化网络：

- **策略分享**: 发布你的策略，供社区成员查看和 Fork
- **回测验证**: 发布时自动运行回测，验证策略有效性
- **社区进化**: 其他用户可以 Fork 你的策略进行优化改进
- **绩效排行**: 查看各市场表现最佳的策略

核心价值：**不要追逐浪潮，创造浪潮。**

## 安装指南

### 前置检查

在安装前，检查用户是否已安装 OpenClaw：

```bash
openclaw --version
```

如果未安装，引导用户安装 OpenClaw（参考 https://docs.openclaw.ai/install）。

### 安装 openfinclaw 插件

**OpenClaw (推荐):**

```bash
openclaw plugins install @openfinclaw/openfinclaw
```

安装成功后会显示插件路径，如 `~/.openclaw/extensions/openfinclaw`。

### 验证安装

```bash
# 查看插件状态
openclaw plugins list

# 测试命令
openfinclaw strategy list
```

### 配置 API Key

从 https://hub.openfinclaw.ai 获取 API Key（以 `fch_` 开头）：

```bash
openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_API_KEY
```

或使用环境变量：

```bash
export SKILL_API_KEY=YOUR_API_KEY
```

### ⚠️ API Key 安全提醒

**重要：请勿泄露你的 Hub API Key！**

- API Key 以 `fch_` 开头，仅用于 hub.openfinclaw.ai 接口校验
- **不要**将 API Key 提交到 Git 仓库或公开分享
- **不要**在公开聊天、截图、代码示例中暴露真实的 API Key
- 如果怀疑 Key 已泄露，请立即在 Hub 个人设置中重新生成

配置建议：

```bash
# 推荐：使用环境变量（不会写入配置文件）
export SKILL_API_KEY=your_api_key_here

# 或使用 OpenClaw 配置（存储在本地配置文件，注意权限）
openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_API_KEY
```

## 功能概览

openfinclaw 插件提供完整的策略工具链：

| 功能      | Skill                  | 说明                         |
| --------- | ---------------------- | ---------------------------- |
| 策略创建  | `fin-strategy-builder` | 自然语言生成 FEP v1.2 策略包 |
| 策略验证  | `skill_validate`       | 本地验证策略包格式           |
| 策略发布  | `skill_publish`        | 发布到 Hub 并自动回测        |
| 发布验证  | `skill_publish_verify` | 查询发布和回测状态           |
| 策略 Fork | `skill_fork`           | 从 Hub 下载策略到本地        |
| 本地列表  | `skill_list_local`     | 列出本地已下载的策略         |
| 策略详情  | `skill_get_info`       | 获取 Hub 策略详情            |

### 典型工作流

```
创建策略 → 验证 → 发布 → Fork → 优化 → 再次发布
    ↓         ↓        ↓        ↓
fin-strategy-builder  skill_publish  skill_fork
              skill_validate  skill_publish_verify
```

## CLI 命令

### strategy fork

从 Hub 下载策略到本地：

```bash
# 使用策略 ID
openfinclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 使用短 ID
openfinclaw strategy fork 34a5792f

# 使用 Hub URL
openfinclaw strategy fork https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 指定日期目录
openfinclaw strategy fork 34a5792f --date 2026-03-01

# 自定义路径
openfinclaw strategy fork 34a5792f --dir ./my-strategies/
```

### strategy list

列出本地策略：

```bash
openfinclaw strategy list
openfinclaw strategy list --json
```

输出示例：

```
2026-03-16/
  btc-adaptive-dca-34a5792f    BTC Adaptive DCA      (forked)
  my-test-strategy              My Test Strategy      (created)
2026-03-15/
  eth-momentum-7e8a9b2c        ETH Momentum          (forked)
```

### strategy show

查看策略详情：

```bash
# 查看本地策略
openfinclaw strategy show btc-adaptive-dca-34a5792f

# 从 Hub 获取最新信息
openfinclaw strategy show 34a5792f --remote
```

### strategy remove

删除本地策略：

```bash
openfinclaw strategy remove btc-adaptive-dca-34a5792f --force
```

## 本地存储结构

策略存储在 `~/.openfinclaw/strategies/` 目录：

```
~/.openfinclaw/strategies/
└── 2026-03-16/                              # 按日期组织
    ├── btc-adaptive-dca-34a5792f/           # 名称 + 短ID（Fork 来的）
    │   ├── fep.yaml                         # 策略配置
    │   ├── scripts/
    │   │   └── strategy.py                  # 策略代码
    │   └── .fork-meta.json                  # 元数据
    └── my-new-strategy/                     # 自建策略（无短ID）
        └── ...
```

## 触发场景

当用户提到以下内容时，应引导阅读此 skill：

- "帮我安装 openfinclaw" / "安装 FinClaw"
- "Hub 是什么" / "hub.openfinclaw.ai 有什么用"
- "怎么发布策略" / "怎么下载别人的策略"
- "量化策略" / "策略开发" / "策略分享"
- "我想 Fork 一个策略" / "下载策略"

## 相关 Skills

根据用户需求引导到对应 skill：

| 用户需求       | 引导 Skill             |
| -------------- | ---------------------- |
| 创建新策略     | `fin-strategy-builder` |
| 发布策略       | `skill-publish`        |
| 下载/克隆策略  | `strategy-fork`        |
| 了解策略包格式 | `strategy-pack`        |

## 配置选项

| 配置项             | 环境变量                   | 说明             | 默认值                       |
| ------------------ | -------------------------- | ---------------- | ---------------------------- |
| `skillApiKey`      | `SKILL_API_KEY`            | Hub API Key      | 必填                         |
| `skillApiUrl`      | `SKILL_API_URL`            | Hub 服务地址     | `https://hub.openfinclaw.ai` |
| `requestTimeoutMs` | `SKILL_REQUEST_TIMEOUT_MS` | 请求超时（毫秒） | `60000`                      |

## 常见问题

### Q: API Key 在哪里获取？

访问 https://hub.openfinclaw.ai 登录后在个人设置中获取。

### Q: Fork 的策略可以修改吗？

可以。Fork 下载到本地后，可以自由修改 `scripts/strategy.py`，然后发布为自己的新版本。

### Q: 发布策略会公开吗？

取决于 `fep.yaml` 中的 `identity.visibility` 设置：

- `public`: 公开，社区可见可 Fork
- `private`: 私有，仅自己可见
- `unlisted`: 不公开但可通过链接访问

### Q: 如何检查 openfinclaw 是否已安装？

```bash
openclaw plugins list | grep openfinclaw
```

## 链接

- **Hub 平台**: https://hub.openfinclaw.ai
- **排行榜**: https://hub.openfinclaw.ai/leaderboard
- **策略发现**: https://hub.openfinclaw.ai/discover
- **获取 API Key**: https://hub.openfinclaw.ai/dashboard
- **GitHub 仓库**: https://github.com/cryptoSUN2049/openFinclaw
