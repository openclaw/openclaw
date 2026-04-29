# Security Guardrail - 可逆敏感数据脱敏层

## 概述

Security Guardrail 是 OpenClaw 的安全增强功能，在用户消息发往公有云端 LLM 之前，自动识别并替换敏感信息（密码、API Key、内网 IP、数据库连接串等），用 `[VAULT_N]` 占位符代替。云端模型基于占位符生成回复后，系统自动将占位符还原为真实值再展示给用户。

**核心价值：云端模型全程看不到真实的敏感数据，但用户体验不受影响。**

## 工作流程

```
用户消息                    本地模型/正则                云端 LLM
    │                          │                          │
    │  "连接 mysql://admin:    │                          │
    │   MySecret@192.168.1.1"  │                          │
    │ ─────────────────────►   │                          │
    │                     检测敏感信息                     │
    │                   ["MySecret","192.168.1.1"]         │
    │                          │                          │
    │                     替换为占位符                     │
    │                   "连接 mysql://admin:               │
    │                    [VAULT_1]@[VAULT_2]"              │
    │                          │ ────────────────────────► │
    │                          │                    生成回复(含占位符)
    │                          │ ◄──────────────────────── │
    │                     还原占位符                       │
    │ ◄───────────────────     │                          │
    │  回复中 [VAULT_1] →      │                          │
    │  MySecret 已还原         │                          │
```

## 双模式脱敏

### 模式一：本地 LLM 语义检测（推荐）

通过本地部署的 OpenAI 兼容 API 模型（如 Qwen、LLaMA 等）进行语义理解，能识别上下文中的敏感信息，覆盖面更广。

### 模式二：正则匹配回退

当本地模型不可用时，自动回退到内置正则规则，覆盖以下类型：

- AWS Access Key (`AKIA...`)
- API Key / Secret Key / Token
- 数据库连接串 (`mysql://`, `postgres://`, `mongodb://` 等)
- SSH/RSA 私钥 (`-----BEGIN ... PRIVATE KEY-----`)
- 内网 IP 地址 (`10.x`, `172.16-31.x`, `192.168.x`)

## 配置方式

### 方式一：通过 Web UI 配置

1. 打开 Control UI → 配置 → AI & Agents 标签页
2. 找到 **Security Guardrail**（盾牌图标）
3. 填写以下字段：

| 字段                      | 说明                            | 示例                           |
| ------------------------- | ------------------------------- | ------------------------------ |
| Enable Security Guardrail | 启用开关                        | `true`                         |
| Local Model API URL       | 本地模型 API 地址               | `http://10.14.101.124:1234/v1` |
| Local Model API Key       | API Key（LM Studio 可填任意值） | `lm-studio`                    |
| Local Model ID            | 模型标识                        | `qwen3-30b-a3b`                |
| Custom Filtering Rules    | 自定义过滤规则（可选）          | `还需要过滤所有项目代号`       |
| Regex Fallback            | 模型不可用时回退到正则          | `true`                         |

### 方式二：通过配置文件

在 OpenClaw 配置文件中添加：

```json
{
  "securityGuardrail": {
    "enable": true,
    "localBaseUrl": "http://10.14.101.124:1234/v1",
    "localApiKey": "lm-studio",
    "localModel": "qwen3-30b-a3b",
    "fallbackToRegexOnly": true
  }
}
```

## 端到端验证结果

### 测试输入

```
帮我连接数据库 mysql://admin:MySecret123@192.168.1.100:3306/prod 并查询用户表
```

### 第一步：本地模型检测

```
检测到敏感项: ["MySecret123"]
```

### 第二步：脱敏后发给云端

```
帮我连接数据库 mysql://admin:[VAULT_1]@192.168.1.100:3306/prod 并查询用户表
```

云端模型 **完全看不到** 真实密码 `MySecret123`。

### 第三步：云端回复（含占位符）

```bash
mysql -h 192.168.1.100 -P 3306 -u admin -p'[VAULT_1]' prod
```

### 第四步：还原后展示给用户

```bash
mysql -h 192.168.1.100 -P 3306 -u admin -p'MySecret123' prod
```

用户看到的命令可以直接复制执行，体验无感。

## 性能优化

Guardrail **仅对用户主动发送的消息生效**，以下场景会跳过：

- 内部命令（`/new`、session slug 生成）
- 定时任务触发（cron）
- 心跳检测（heartbeat）
- 内存刷新（memory）
- 溢出处理（overflow）

这避免了每次内部操作都调用本地模型导致的延迟。

## 架构与文件清单

### 核心安全模块

| 文件                       | 职责                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `src/security/vault.ts`    | TokenVault 类：双向映射表，负责 redact（替换）和 restore（还原） |
| `src/security/patterns.ts` | 内置正则规则，覆盖 AWS Key、数据库连接串、私钥、内网 IP 等       |
| `src/security/scanner.ts`  | Guardrail 主入口：本地 LLM 调用 + 正则回退 + Finding 转换        |

### 配置集成

| 文件                                     | 职责                                           |
| ---------------------------------------- | ---------------------------------------------- |
| `src/config/types.security-guardrail.ts` | TypeScript 类型定义                            |
| `src/config/zod-schema.ts`               | Zod 校验 schema                                |
| `src/config/schema.labels.ts`            | UI 字段标签                                    |
| `src/config/schema.help.ts`              | UI 字段帮助文本                                |
| `src/config/schema.hints.ts`             | UI 分组与排序                                  |
| `src/config/schema.base.generated.ts`    | 生成的 JSON Schema（`pnpm config:schema:gen`） |

### Runner 集成

| 文件                                           | 行    | 职责                                            |
| ---------------------------------------------- | ----- | ----------------------------------------------- |
| `src/agents/pi-embedded-runner/run.ts`         | ~681  | 去程：调用 applyGuardrail 脱敏 prompt           |
| `src/agents/pi-embedded-runner/run.ts`         | ~1653 | 回程：还原 assistantTexts 和 finalAssistantText |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ~694  | 回程：还原工具执行参数（tool args）             |

### UI 集成

| 文件                                    | 职责                      |
| --------------------------------------- | ------------------------- |
| `ui/src/ui/views/config-form.render.ts` | 盾牌图标 + SECTION_META   |
| `ui/src/ui/app-render.ts`               | 添加到 AI & Agents 标签页 |

## 注意事项

1. **本地模型选择**：推荐使用支持中文的模型（如 Qwen 系列），确保能正确识别中文语境下的敏感信息。
2. **网络隔离**：本地模型应部署在内网环境，确保敏感数据不出内网。
3. **自定义规则**：通过 `customPrompt` 字段可扩展检测范围，例如添加公司特定的项目代号、内部域名等。
4. **配置变更**：修改 Guardrail 配置后 gateway 会自动重启生效。
5. **显式启用**：Guardrail 默认关闭，必须设置 `enable: true` 才会激活。
