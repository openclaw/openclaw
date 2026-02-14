# QVerisBot 从源码安装与运行指南

本文档用于从源码完成 QVerisBot 的安装、配置、启动与排障，适用于 macOS 和 Linux。

如果你希望更快安装（npm 包或 one-liner），请先看 [安装总览](/install)。

---

## 适用范围

- 你希望本地部署并自行控制数据与配置
- 你需要飞书渠道、X (Twitter) 渠道或 QVeris 工具能力
- 你希望基于 OpenClaw CLI 进行开发与调试

---

## 功能概览

QVerisBot 基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建，核心能力包括：

- 多渠道接入（飞书、X、Telegram、Slack、Discord、Signal、Web 等）
- QVeris 工具调用（搜索工具并执行）
- X 渠道与 `x-actions`（读写操作）
- 本地网关架构（适合开发与私有部署）

QVeris 相关接口：

- `qveris_search`：搜索可用工具
- `qveris_execute`：执行指定工具

---

## 1. 环境准备

### 1.1 最低要求

| 组件    | 最低版本 | 推荐       |
| ------- | -------- | ---------- |
| Node.js | 22+      | 22.x LTS   |
| pnpm    | 10+      | 最新稳定版 |
| Python  | 3.12+    | 3.12+      |
| Git     | 2+       | 最新稳定版 |

### 1.2 macOS 安装示例

```bash
# 1) Node.js (推荐 nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 22
nvm use 22
nvm alias default 22

# 2) pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.zshrc

# 3) Python
brew install python@3.12

# 4) 验证
node --version
pnpm --version
python3 --version
```

### 1.3 Linux (Ubuntu/Debian) 安装示例

```bash
# 1) 系统更新
sudo apt update && sudo apt upgrade -y

# 2) Node.js (推荐 nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
nvm alias default 22

# 3) pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.bashrc

# 4) Python
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3.12-dev python3-pip

# 5) 常用依赖
sudo apt install -y build-essential git

# 6) 验证
node --version
pnpm --version
python3.12 --version
```

### 1.4 可选 Python 库

```bash
# 常用测试/脚本依赖
pip3 install requests matplotlib

# 技能开发依赖
pip3 install fastapi httpx uvicorn pytest
```

---

## 2. 飞书应用准备（建议先完成）

飞书配置分两步：先创建应用和权限，等网关启动后再配置事件订阅。

### 2.1 创建应用与机器人

1. 打开 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 添加机器人能力
4. 在「凭证与基础信息」获取 `App ID` 与 `App Secret`

### 2.2 配置权限

最小建议权限：

- `im:message`
- `im:chat:readonly`
- `im:chat`
- `im:message:send_as_bot`
- `im:message.p2p_msg:readonly`
- `im:message.group_msg:readonly`
- `im:message.mention:readonly`
- `im:resource`

可选权限：

- `contact:user.base:readonly`

### 2.3 发布应用

在「版本管理与发布」中创建版本并发布，同时设置机器人可用范围（用户/部门）。未在可用范围中的用户无法正常使用机器人。

### 2.4 事件订阅（第二步）

在网关启动成功后，进入「事件订阅」并选择「使用长连接接收事件」，添加：

- `im.message.receive_v1`
- `im.message.message_read_v1`
- `im.message.recalled_v1`
- `im.chat.member.bot.added_v1`
- `im.chat.access_event.bot_p2p_chat_entered_v1`

---

## 3. 获取源码与构建

### 3.1 克隆项目

```bash
git clone https://github.com/QVerisAI/QVerisBot.git
cd QVerisBot
```

### 3.2 安装与编译

```bash
# 安装依赖
pnpm install

# 首次建议构建 UI
pnpm ui:build

# 编译 TypeScript
pnpm build
```

### 3.3 验证构建结果

```bash
ls -la dist/
pnpm openclaw --version
```

---

## 4. Onboard 一键配置（推荐）

从当前版本开始，`qverisbot onboard`（兼容 `openclaw onboard`）已支持在向导内完成 QVeris、Feishu、X 的关键认证配置。  
常规场景下**无需手动编辑** `~/.openclaw/openclaw.json`，只需要在向导里填入对应 auth 信息即可开箱使用。

### 4.1 一键流程（CLI）

```bash
pnpm openclaw onboard --flow quickstart
```

如果你通过 npm 全局安装：

```bash
qverisbot onboard --flow quickstart
# 兼容别名:
openclaw onboard --flow quickstart
```

建议选择 `quickstart`，按提示完成：

1. 模型与网关基础设置
2. QVeris 工具开关与 API Key
3. 渠道配置（选择并配置 Feishu、X）
4. 技能与初始化收尾

### 4.2 向导中需要填写的认证信息

| 模块   | 向导内填写项                                                             | 说明                                             |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| QVeris | `QVeris API key`                                                         | 开启后会默认将 `web_search` provider 设为 QVeris |
| Feishu | `App ID`、`App Secret`（或使用环境变量）                                 | 向导还会引导选择 Feishu/Lark 域名与群策略        |
| X      | `Consumer Key`、`Consumer Secret`、`Access Token`、`Access Token Secret` | 向导会同时收集 `allowFrom` 与 `actionsAllowFrom` |

说明：

- QVeris 若检测到 `QVERIS_API_KEY` 环境变量，可不在向导中重复输入
- Feishu 若检测到 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，可直接复用环境变量
- X 建议在向导内一次填全凭证与白名单，后续即可直接使用 x-actions

### 4.3 macOS App Onboarding

如果你使用 macOS 菜单栏应用，也可以在应用内的 onboarding 页面完成同类引导；其 wizard 流程与 CLI onboarding 能力保持一致方向，适合不习惯命令行的用户。

### 4.4 运行后快速验证

```bash
pnpm openclaw channels status
pnpm openclaw channels status --deep
pnpm openclaw channels status feishu
pnpm openclaw channels status x
```

全局安装版本可直接使用：

```bash
qverisbot channels status
qverisbot channels status --deep
```

---

## 5. 高级：手动配置（可选）

配置文件路径：`~/.openclaw/openclaw.json`

```bash
mkdir -p ~/.openclaw
```

### 5.1 最小可用配置（飞书 + QVeris + X）

> 建议将密钥放环境变量，配置文件里使用占位符或非敏感项。

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-opus-4-5" },
      "workspace": "~/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "bind": "loopback"
  },
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "eventMode": "websocket",
      "startupChatId": "oc_xxx",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "requireMention": true,
      "promptSuffix": "请用中文回答。"
    },
    "x": {
      "enabled": true,
      "consumerKey": "your-consumer-key",
      "consumerSecret": "your-consumer-secret",
      "accessToken": "your-access-token",
      "accessTokenSecret": "your-access-token-secret",
      "allowFrom": [],
      "actionsAllowFrom": [],
      "pollIntervalSeconds": 60
    }
  },
  "tools": {
    "qveris": {
      "enabled": true,
      "apiKey": "qv_xxx",
      "baseUrl": "https://qveris.ai/api/v1",
      "timeoutSeconds": 60,
      "maxResponseSize": 20480,
      "searchLimit": 10
    },
    "web": {
      "search": {
        "enabled": true,
        "provider": "qveris",
        "qveris": {
          "toolId": "xiaosu.smartsearch.search.retrieve.v2.6c50f296_domestic"
        }
      },
      "fetch": { "enabled": true }
    }
  },
  "models": {
    "proxy": "http://127.0.0.1:7890"
  }
}
```

### 5.2 高频配置说明

#### 飞书渠道

| 配置项                     | 说明                              |
| -------------------------- | --------------------------------- |
| `appId` / `appSecret`      | 飞书应用凭证                      |
| `eventMode`                | 推荐 `websocket`                  |
| `startupChatId`            | 启动通知群组 ID，可为字符串或数组 |
| `allowOnlyStartupChats`    | 仅允许指定启动群组                |
| `dmPolicy` / `groupPolicy` | 私聊/群聊策略                     |
| `requireMention`           | 群聊是否要求 @ 机器人             |
| `promptSuffix`             | 在用户消息后附加提示词            |

`startupChatId` 可通过以下方式获取：

1. 飞书群设置查看群号（`oc_xxx`）
2. 机器人入群后查看网关日志中的 `chatId`

#### X 渠道

| 配置项                              | 说明                         |
| ----------------------------------- | ---------------------------- |
| `consumerKey` / `consumerSecret`    | X 开发者 API Key/Secret      |
| `accessToken` / `accessTokenSecret` | 账号 Token/Secret            |
| `allowFrom`                         | 允许触发 X 渠道响应的用户 ID |
| `actionsAllowFrom`                  | 允许执行 X 写操作的用户 ID   |
| `pollIntervalSeconds`               | 轮询间隔（最小 15）          |
| `proxy`                             | 可选 HTTP 代理               |

支持多账号模式（`channels.x.accounts`），每个账号可独立配置凭证与白名单。

#### QVeris 工具

| 配置项            | 说明                             |
| ----------------- | -------------------------------- |
| `apiKey`          | QVeris API Key（也可用环境变量） |
| `baseUrl`         | 默认 `https://qveris.ai/api/v1`  |
| `timeoutSeconds`  | 请求超时秒数                     |
| `maxResponseSize` | 最大响应字节数                   |
| `searchLimit`     | 搜索结果上限                     |

### 5.3 `x-actions` 与权限模型

请通过 `message` 工具的 `x-*` 动作操作 X，不使用浏览器自动化。

写操作：

- `x-post` / `x-reply` / `x-quote`
- `x-like` / `x-unlike`
- `x-repost` / `x-unrepost`
- `x-follow` / `x-unfollow`
- `x-dm`

读操作：

- `x-search` / `x-timeline`
- `x-tweet-info` / `x-user-info`
- `x-me`

权限规则（重点）：

- 读操作不需要额外授权
- 写操作需要 `channels.x.actionsAllowFrom`
- 若要对飞书用户做更细粒度限制，可配置 `channels.feishu.xActionsAllowFrom`

### 5.4 环境变量（推荐放敏感信息）

```bash
# Feishu
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"

# QVeris
export QVERIS_API_KEY="qv_xxx"

# LLM Provider Keys
export ANTHROPIC_API_KEY="sk-ant-xxx"
export OPENAI_API_KEY="sk-xxx"

# Proxy (optional)
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"
```

---

## 6. 启动与验证

### 6.1 启动网关

```bash
# 前台运行（调试推荐）
pnpm openclaw gateway --port 18789 --verbose

# 后台运行
nohup pnpm openclaw gateway --port 18789 > /tmp/openclaw-gateway.log 2>&1 &
```

### 6.2 健康检查

```bash
pnpm openclaw channels status
pnpm openclaw channels status --deep
pnpm openclaw channels status feishu
pnpm openclaw channels status x
```

### 6.3 完成飞书事件订阅

当日志出现类似内容时，返回飞书平台完成事件订阅配置：

```text
feishu: connecting to Feishu WebSocket server...
feishu: WebSocket connection established
feishu: connected as "QVerisBot" (ou_xxx)
```

---

## 7. 使用示例

### 7.1 常用聊天命令（飞书）

| 命令                     | 作用             |
| ------------------------ | ---------------- |
| `/status`                | 查看当前会话状态 |
| `/new` 或 `/reset`       | 重置会话         |
| `/compact`               | 压缩上下文       |
| `/think <level>`         | 设置思考级别     |
| `/verbose on/off`        | 开关详细模式     |
| `/usage off/tokens/full` | 设置用量展示     |

### 7.2 X 操作方式

- 在任意支持通道中用自然语言触发（如“帮我发一条推文”）
- 在飞书中也可使用 `/x` 命令（如 `/x follow @user`、`/x like <tweet-url>`）

### 7.3 QVeris 工具示例

```text
查询今天北京天气并给出出行建议
搜索最新的 AI 技术新闻并总结要点
查询腾讯股票近期行情并给出风险提示
```

### 7.4 CLI 示例

```bash
# 发送消息
pnpm openclaw message send --to oc_xxx --message "Hello from QVerisBot"

# 与助手对话
pnpm openclaw agent --message "帮我写一个 Python 脚本" --thinking high

# 查看帮助
pnpm openclaw --help
```

---

## 8. 故障排查

### 8.1 通用诊断

```bash
pnpm openclaw doctor
```

```bash
# 网关日志
tail -f /tmp/openclaw-gateway.log

# 更多日志
pnpm openclaw gateway --verbose
DEBUG=* pnpm openclaw gateway
```

### 8.2 常见问题速查

#### 飞书消息收不到

1. 应用是否已发布
2. 权限与事件是否已配置
3. 用户是否在机器人可用范围
4. 日志是否显示 WebSocket 已连接
5. `startupChatId` 是否正确

#### QVeris 调用失败

1. `QVERIS_API_KEY` 是否正确
2. 网络是否可达（必要时配置代理）
3. 查看网关日志中的具体报错

#### 大模型调用超时

1. 检查 `models.proxy`
2. 验证代理服务是否正常
3. 切换模型提供商进行对比

#### X 写操作被拒绝

1. 确认 `channels.x.actionsAllowFrom` 已配置
2. 如来自飞书并需细粒度控制，配置 `channels.feishu.xActionsAllowFrom`
3. 读操作无需权限，写操作才受白名单限制

---

## 9. 参考链接

- [QVeris 官网](https://qveris.ai)
- [QVerisBot GitHub](https://github.com/QVerisAI/QVerisBot)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [OpenClaw CLI Onboard 参考](https://docs.openclaw.ai/start/wizard-cli-reference)
- [飞书开放平台](https://open.feishu.cn)

---

如需继续扩展，可在此文档基础上补充你团队的内网部署、代理规范和凭证管理流程。
