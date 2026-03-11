---
title: "OpenFinClaw 插件安装与配置指南"
summary: "如何安装和配置 @openfinclaw/openfinclaw 金融工具插件"
---

# OpenFinClaw 插件安装与配置指南

## 安装

### 方式一：一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

### 方式二：手动安装

```bash
openclaw plugins install @openfinclaw/openfinclaw
```

---

## 配置 API Key

安装后需要配置 Skill API Key 才能使用策略发布和回测功能。

### 方式一：CLI 命令（推荐）

```bash
# 获取 API Key: https://hub.openfinclaw.ai
openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_API_KEY

# 可选：修改服务器地址
openclaw config set plugins.entries.openfinclaw.config.skillApiUrl https://hub.openfinclaw.ai
```

### 方式二：环境变量

```bash
export SKILL_API_KEY=YOUR_API_KEY
export SKILL_API_URL=https://hub.openfinclaw.ai
```

### 方式三：直接编辑配置文件

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "openfinclaw": {
        "enabled": true,
        "config": {
          "skillApiUrl": "https://hub.openfinclaw.ai",
          "skillApiKey": "fch_xxxxxxxx"
        }
      }
    }
  }
}
```

### 配置项说明

| 配置项             | 说明                               | 默认值                       |
| ------------------ | ---------------------------------- | ---------------------------- |
| `skillApiKey`      | API Key（以 `fch_` 开头，68 字符） | 无（必需）                   |
| `skillApiUrl`      | Skill Server 地址                  | `https://hub.openfinclaw.ai` |
| `requestTimeoutMs` | 请求超时（毫秒）                   | `60000`                      |

### 环境变量

| 环境变量                   | 对应配置项         |
| -------------------------- | ------------------ |
| `SKILL_API_KEY`            | `skillApiKey`      |
| `SKILL_API_URL`            | `skillApiUrl`      |
| `SKILL_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` |

---

## 功能

### 可用工具

| 工具                   | 说明                                |
| ---------------------- | ----------------------------------- |
| `skill_publish`        | 发布策略 ZIP 到服务器，自动触发回测 |
| `skill_publish_verify` | 查询发布状态和回测结果              |
| `skill_validate`       | 本地校验策略包目录（发布前必做）    |

### 可用 Skills

| Skill                  | 说明                                        |
| ---------------------- | ------------------------------------------- |
| `skill-publish`        | 策略发布流程：校验 → 打包 → 发布 → 轮询结果 |
| `fin-strategy-builder` | 自然语言构建交易策略                        |

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

```bash
# 当前版本
grep '"version"' extensions/openfinclaw/package.json

# 更新版本
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

### API Key 无效

确保 API Key 以 `fch_` 开头，长度为 68 字符。如需获取新 Key，访问 https://hub.openfinclaw.ai 。
