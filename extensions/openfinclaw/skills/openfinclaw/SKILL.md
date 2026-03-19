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

## 快速开始

安装完成后，你可以立即开始（无需 API Key）：

```bash
# 1. 查看排行榜（无需 API Key）
openclaw strategy leaderboard

# 2. 查看收益榜 Top 10
openclaw strategy leaderboard returns --limit 10

# 3. 查看策略详情（无需 API Key）
openclaw strategy show 550e8400-e29b-41d4-a716-446655440001 --remote
```

或者直接告诉 Agent 你想做什么：

- "帮我看看排行榜有什么好策略" → Agent 会使用 `skill_leaderboard`
- "这个策略收益怎么样" → Agent 会使用 `skill_get_info`
- "帮我 Fork 这个策略" → Agent 会使用 `skill_fork`（需要配置 API Key）

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
openclaw plugins install @openfinclaw/openfinclaw-strategy

openclaw plugins enable @openfinclaw/openfinclaw-strategy
```

安装成功后会显示插件路径，如 `~/.openclaw/extensions/openfinclaw`。

### 验证安装

```bash
# 查看插件状态
openclaw plugins list

# 测试命令
openclaw strategy list
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

本插件提供两类能力：

### Tools（工具）

Agent 可直接调用的函数：

| 工具名                 | 用途                                   | 需要 API Key |
| ---------------------- | -------------------------------------- | ------------ |
| `skill_leaderboard`    | 查询排行榜（综合/收益/风控/人气/新星） | 否           |
| `skill_get_info`       | 获取 Hub 策略公开详情                  | 否           |
| `skill_validate`       | 本地验证策略包格式（FEP v2.0）         | 否           |
| `skill_list_local`     | 列出本地已下载的策略                   | 否           |
| `skill_fork`           | 从 Hub 下载公开策略到本地              | **是**       |
| `skill_publish`        | 发布策略 ZIP 到 Hub，自动触发回测      | **是**       |
| `skill_publish_verify` | 查询发布状态和回测报告                 | **是**       |

### Skills（指导文档）

定义 Agent 在特定场景下的行为规范，位于 `skills/` 目录：

| Skill              | 触发场景                 | 说明                          |
| ------------------ | ------------------------ | ----------------------------- |
| `strategy-builder` | 创建新策略、生成策略代码 | 自然语言 → FEP v2.0 策略包    |
| `skill-publish`    | 发布策略到服务器         | 验证 → 打包 → 发布 → 查询回测 |
| `strategy-fork`    | 下载/克隆 Hub 策略       | Fork → 本地编辑 → 发布新版本  |
| `strategy-pack`    | 创建回测策略包           | 生成 fep.yaml + strategy.py   |

### 典型工作流

```
创建策略 → 验证 → 发布 → Fork → 优化 → 再次发布
    ↓         ↓        ↓        ↓
 strategy-builder  skill_publish  skill_fork
               skill_validate  skill_publish_verify
```

## CLI 命令

### strategy leaderboard

查看 Hub 排行榜（无需 API Key）：

```bash
# 综合榜 Top 20（默认）
openclaw strategy leaderboard

# 收益榜 Top 10
openclaw strategy leaderboard returns --limit 10

# 人气榜第 21-40 名
openclaw strategy leaderboard popular --offset 20 --limit 20
```

**榜单类型**：

| 榜单类型    | 说明           | 排序依据         |
| ----------- | -------------- | ---------------- |
| `composite` | 综合榜（默认） | FCS 综合分       |
| `returns`   | 收益榜         | 收益率           |
| `risk`      | 风控榜         | 风控分           |
| `popular`   | 人气榜         | 订阅数           |
| `rising`    | 新星榜         | 30天内新策略收益 |

### strategy fork

从 Hub 下载策略到本地：

```bash
# 使用策略 ID
openclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 使用 Hub URL
openclaw strategy fork https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 指定日期目录
openclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6 --date 2026-03-01

# 自定义路径
openclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6 --dir ./my-strategies/
```

### strategy list

列出本地策略：

```bash
openclaw strategy list
openclaw strategy list --json
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
openclaw strategy show btc-adaptive-dca-34a5792f

# 从 Hub 获取最新信息（无需 API Key）
openclaw strategy show 550e8400-e29b-41d4-a716-446655440001 --remote
```

### strategy remove

删除本地策略：

```bash
openclaw strategy remove btc-adaptive-dca-34a5792f --force
```

## 本地存储结构

策略存储在 `~/.openfinclaw/workspace/strategies/` 目录：

```
~/.openfinclaw/workspace/strategies/
└── 2026-03-16/                              # 按日期组织
    ├── btc-adaptive-dca-34a5792f/           # 名称 + 短ID（Fork 来的）
    │   ├── fep.yaml                         # 策略配置
    │   ├── scripts/
    │   │   └── strategy.py                  # 策略代码
    │   └── .fork-meta.json                  # 元数据
    └── my-new-strategy/                     # 自建策略（无短ID）
        └── ...
```

## 触发场景与相关 Skills

当用户提到以下内容时，应引导阅读对应的 Skill：

| 触发关键词                     | Skill 目录         | 说明                                    |
| ------------------------------ | ------------------ | --------------------------------------- |
| 创建策略、写策略、生成策略包   | `strategy-builder` | 自然语言 → FEP v2.0 策略包              |
| 发布策略、上传策略、提交策略   | `skill-publish`    | 验证 → 打包 → 发布到 Hub → 查询回测报告 |
| Fork 策略、下载策略、克隆策略  | `strategy-fork`    | 从 Hub Fork 策略到本地，支持二次开发    |
| 策略包格式、FEP 规范、打包回测 | `strategy-pack`    | FEP v2.0 规范详解，打包和校验指南       |

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
