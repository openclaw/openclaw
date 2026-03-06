---
title: "OpenFinClaw 插件安装与发布指南"
summary: "如何安装和发布 @openfinclaw/* 金融工具插件"
---

# OpenFinClaw 插件安装与发布指南

## 用户安装

### 快速安装

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

### 手动安装

```bash
# 安装 OpenClaw（如果未安装）
curl -fsSL https://openclaw.ai/install.sh | bash

# 安装 OpenFinClaw 插件套件
openclaw plugins install @openfinclaw/openfinclaw

# 重启 Gateway
openclaw gateway restart
```

### 配置 API Key

```bash
# 获取 API Key: https://hub.openfinclaw.ai
openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_API_KEY
openclaw config set plugins.entries.openfinclaw.config.backtestApiUrl https://backtest.openfinclaw.ai
```

### 包含的功能

| Skill/Tool             | 说明                               |
| ---------------------- | ---------------------------------- |
| `fin-strategy-builder` | 从自然语言创建 FEP v1.2 策略包     |
| `fin-backtest-remote`  | 提交策略到远程回测服务器           |
| `fin-market-data`      | 市场数据工具（价格、订单簿、行情） |
| `fin-strategy-engine`  | 策略生命周期管理                   |

---

## 开发者发布

### 前置条件

1. npm 账号（已加入 @openfinclaw 组织）
2. 已登录 npm：`npm login`

### 一键发布

```bash
# 构建并发布所有 @openfinclaw/* 插件
pnpm plugins:publish:openfinclaw
```

### 手动发布

```bash
# 1. 构建
pnpm build

# 2. 发布（按依赖顺序）
pnpm --filter @openfinclaw/fin-shared-types publish --access public --no-git-checks --otp=YOUR_OTP
pnpm --filter @openfinclaw/fin-core publish --access public --no-git-checks --otp=YOUR_OTP
pnpm --filter @openfinclaw/fin-market-data publish --access public --no-git-checks --otp=YOUR_OTP
pnpm --filter @openfinclaw/fin-strategy-engine publish --access public --no-git-checks --otp=YOUR_OTP
pnpm --filter @openfinclaw/fin-backtest-remote publish --access public --no-git-checks --otp=YOUR_OTP
pnpm --filter @openfinclaw/openfinclaw publish --access public --no-git-checks --otp=YOUR_OTP
```

### 验证发布

```bash
# 检查版本
npm view @openfinclaw/openfinclaw version

# 测试安装
openclaw plugins install @openfinclaw/openfinclaw
```

---

## 包结构

### Meta 包: `@openfinclaw/openfinclaw`

```
extensions/openfinclaw/
├── package.json           # 依赖所有 fin-* 插件
├── openclaw.plugin.json   # 插件清单（含 skills 声明）
├── README.md              # 文档
└── skills/
    └── fin-strategy-builder/
        └── SKILL.md       # 策略构建 Skill
```

### 依赖包

| 包名                               | 目录                              | 说明         |
| ---------------------------------- | --------------------------------- | ------------ |
| `@openfinclaw/fin-shared-types`    | `extensions/fin-shared-types/`    | 共享类型定义 |
| `@openfinclaw/fin-core`            | `extensions/fin-core/`            | 核心基础设施 |
| `@openfinclaw/fin-market-data`     | `extensions/fin-market-data/`     | 市场数据工具 |
| `@openfinclaw/fin-strategy-engine` | `extensions/fin-strategy-engine/` | 策略引擎     |
| `@openfinclaw/fin-backtest-remote` | `extensions/fin-backtest-remote/` | 远程回测     |

### 依赖关系

```
@openfinclaw/openfinclaw (Meta 包)
├── @openfinclaw/fin-shared-types
├── @openfinclaw/fin-core
├── @openfinclaw/fin-market-data
├── @openfinclaw/fin-strategy-engine
└── @openfinclaw/fin-backtest-remote
    └── skills/backtest-server/SKILL.md
```

---

## 版本同步

所有 `@openfinclaw/*` 包版本与主包 `openfinclaw` 保持同步。

```bash
# 同步版本号
pnpm plugins:sync

# 手动更新版本
# 修改根目录 package.json 的 version
# 然后运行 pnpm plugins:sync
```

---

## 相关文件

| 文件                             | 说明         |
| -------------------------------- | ------------ |
| `scripts/publish-openfinclaw.sh` | 发布脚本     |
| `scripts/install-finclaw.sh`     | 用户安装脚本 |
| `extensions/openfinclaw/`        | Meta 包目录  |
| `docs/plugins/openfinclaw.md`    | 本文档       |

---

## 相关链接

| 链接                                         | 说明         |
| -------------------------------------------- | ------------ |
| https://github.com/cryptoSUN2049/openFinclaw | 源码仓库     |
| https://hub.openfinclaw.ai                   | 获取 API Key |

---

## 故障排除

### npm 发布失败

```bash
# 检查登录状态
npm whoami

# 重新登录
npm login

# 检查组织权限
npm access list packages @openfinclaw
```

### 插件安装失败

```bash
# 检查 openclaw 版本
openclaw --version  # 需要 >= 2026.2.0

# 手动安装
openclaw plugins install @openfinclaw/openfinclaw --verbose
```

### 配置不生效

```bash
# 重启 Gateway
openclaw gateway restart

# 检查配置
openclaw config get plugins.entries.openfinclaw
```
