---
title: "OpenFinClaw 插件安装与发布指南"
summary: "如何安装和发布 @openfinclaw/* 金融工具插件"
---

# OpenFinClaw 插件安装与发布指南

## 用户安装

### 交互式安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

安装时会显示插件选择菜单：

```
🦞 OpenFinClaw Installer

Select plugins to install:
  [x] Shared Types    - Shared types and interfaces (required)
  [x] Fin Core        - Core infrastructure, exchange registry (required)
  [x] Market Data     - Prices, orderbooks, tickers
  [x] Strategy Engine - Indicators, backtest, evolution
  [x] Backtest Remote - Submit backtests to remote server
  [x] OpenFinClaw     - Skills: fin-strategy-builder
```

### 非交互式安装

```bash
# 安装全部插件
OPENFINCLAW_PLUGINS=all curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash

# 安装指定插件
OPENFINCLAW_PLUGINS=fin-core,fin-market-data,openfinclaw curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

### 手动安装

```bash
# 安装单个插件
openclaw plugins install @openfinclaw/fin-core

# 安装全部
openclaw plugins install @openfinclaw/fin-shared-types
openclaw plugins install @openfinclaw/fin-core
openclaw plugins install @openfinclaw/fin-market-data
openclaw plugins install @openfinclaw/fin-strategy-engine
openclaw plugins install @openfinclaw/fin-backtest-remote
openclaw plugins install @openfinclaw/openfinclaw
```

### 配置 API Key

```bash
# 获取 API Key: https://hub.openfinclaw.ai
openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_API_KEY
openclaw config set plugins.entries.openfinclaw.config.backtestApiUrl https://backtest.openfinclaw.ai
```

---

## 可用插件

| 插件            | 包名                               | 说明                         |
| --------------- | ---------------------------------- | ---------------------------- |
| Shared Types    | `@openfinclaw/fin-shared-types`    | 共享类型定义 (必需)          |
| Fin Core        | `@openfinclaw/fin-core`            | 核心基础设施 (必需)          |
| Market Data     | `@openfinclaw/fin-market-data`     | 市场数据工具                 |
| Strategy Engine | `@openfinclaw/fin-strategy-engine` | 策略引擎                     |
| Backtest Remote | `@openfinclaw/fin-backtest-remote` | 远程回测                     |
| OpenFinClaw     | `@openfinclaw/openfinclaw`         | Skills: fin-strategy-builder |

---

## 开发者发布

### 前置条件

1. npm 账号（已加入 @openfinclaw 组织）
2. 创建 Granular Access Token 并设置环境变量

### 创建 Token

1. 访问 https://www.npmjs.com/settings/YOUR_USERNAME/tokens/granular-access-tokens/new
2. 配置：
   - **Packages**: Read and write
   - **Organizations**: @openfinclaw
   - **Enable**: Bypass 2FA for automation
3. 复制生成的 token

### 发布命令

```bash
export NPM_TOKEN=npm_xxxxx
pnpm plugins:publish:openfinclaw
```

### 验证发布

```bash
npm view @openfinclaw/openfinclaw version
```

---

## 版本管理

所有 `@openfinclaw/*` 包使用统一版本号。

```bash
# 当前版本
grep '"version"' extensions/openfinclaw/package.json

# 更新版本（所有包同步更新）
pnpm plugins:sync
```

---

## 相关链接

| 链接                                         | 说明         |
| -------------------------------------------- | ------------ |
| https://github.com/cryptoSUN2049/openFinclaw | 源码仓库     |
| https://hub.openfinclaw.ai                   | 获取 API Key |

---

## 故障排除

### 插件安装失败

```bash
# 检查 openclaw 版本
openclaw --version

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
