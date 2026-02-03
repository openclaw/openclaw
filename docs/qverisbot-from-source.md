# QVerisBot 源码安装、配置与运行指南

本文档详细介绍如何从源码安装、配置和运行 QVerisBot，重点支持 macOS 和 Linux 系统。

---

## 目录

1. [项目简介](#1-项目简介)
2. [安装依赖](#2-安装依赖)
3. [飞书账号准备](#3-飞书账号准备)
4. [克隆代码](#4-克隆代码)
5. [编译项目](#5-编译项目)
6. [配置](#6-配置)
7. [运行](#7-运行)
8. [使用说明](#8-使用说明)

---

## 1. 项目简介

### 1.1 QVerisBot 简介

**QVerisBot** 是由 [QVeris AI](https://qveris.ai) 团队开发的个人 AI 助手，基于开源项目 [OpenClaw](https://github.com/openclaw/openclaw) 进行了深度定制和增强。QVerisBot 不仅仅是一个聊天机器人，而是一个能够调用各类专业工具的多功能 AI 助手。

**核心特性**：

- **QVeris 万能工具箱**：集成 QVeris 平台，可搜索和调用金融、科研、医疗、体育等领域的专业工具
- **飞书原生支持**：深度集成飞书（Feishu/Lark），特别适合中国企业用户
- **多渠道接入**：支持飞书、X (Twitter)、WhatsApp、Telegram、Slack、Discord、Signal 等多种消息平台
- **本地部署**：在你自己的设备上运行，数据安全可控
- **大模型代理**：支持 HTTP 代理，方便在网络受限环境中使用

**GitHub 仓库**：[https://github.com/QVerisAI/QVerisBot](https://github.com/QVerisAI/QVerisBot)

### 1.2 QVeris 万能工具箱

QVerisBot 集成了 [QVeris](https://qveris.ai) 平台的万能工具箱，可以搜索和调用各类外部可信工具，将助手从简单的聊天机器人升级为多功能专业助手。支持的领域包括：

- **金融数据**：股票行情、财务报表、市场分析
- **科研工具**：论文检索、数据分析、实验计算
- **医疗健康**：医学知识库、药物信息查询
- **体育数据**：赛事信息、球员数据、比分查询
- **网络搜索**：智能搜索、新闻聚合、实时信息

QVeris 工具通过两个核心 API 实现：
- `qveris_search`：使用自然语言搜索可用工具
- `qveris_execute`：执行指定工具并获取结果

#### 1.2.1 QVeris 快速开通指南（5 分钟）

按照以下步骤开通 QVeris 并在 QVerisBot 中使用：

**第一步：注册 QVeris 账号**

1. 访问 [qveris.ai](https://qveris.ai)，点击 **注册 / Sign Up**
2. 使用邮箱注册或第三方登录（Google/GitHub）
3. 完成邮箱验证

**第二步：生成 API Key**

1. 登录 [QVeris 控制台](https://qveris.ai/dashboard)
2. 进入 **API Keys** 页面
3. 点击 **创建新 API Key**
4. 复制并安全保存你的 API Key（只显示一次）

**第三步：购买 Credits（免费额度用尽后）**

QVeris 提供免费额度供测试使用。生产环境需要：

1. 进入控制台的 **Billing / 账单** 页面
2. 选择套餐或充值 Credits
3. 每次工具调用消耗 Credits（不同工具价格不同）

**第四步：配置 QVerisBot**

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "tools": {
    "qveris": {
      "enabled": true,
      "apiKey": "qv_你的API密钥"
    }
  }
}
```

或通过环境变量设置（推荐敏感信息使用此方式）：

```bash
export QVERIS_API_KEY="qv_你的API密钥"
```

**第五步：验证配置**

重启 QVerisBot 并测试：

```bash
# 重启网关
pnpm openclaw gateway --port 18789 --verbose

# 测试 QVeris 工具
pnpm openclaw agent --message "使用 QVeris 搜索比特币价格相关的工具"
```

> ⚡ **提示**：QVeris 详细配置选项（超时时间、响应大小限制等）请参考 [6.3.5 QVeris 配置](#635-qveris-配置)。

### 1.3 飞书深度支持

QVerisBot 原生支持飞书（Feishu/Lark），特别适合中国企业用户：

- **群聊支持**：支持飞书群组消息处理
- **WebSocket 长连接**：无需公网 IP，本地开发环境友好
- **消息撤回处理**：支持消息撤回事件，自动停止正在处理的任务 *(🚧 开发中)*
- **富文本消息**：支持 Markdown 格式的消息渲染（renderMode：auto/raw/card）
- **飞书动作**：可配置 reactions、sendMessage、deleteMessage、editMessage
- **飞书文档/知识库/云盘工具**：feishu_doc、feishu_wiki、feishu_drive、feishu_perm（可按账号开关）
- **图片消息**：支持发送和接收图片 *(🚧 开发中)*

### 1.4 X (Twitter) 渠道与 x-actions

QVerisBot 通过 X 扩展支持 X (Twitter) 渠道与 **x-actions** 技能：

- **X 渠道**：轮询 @ 提及，在 X 上 @ 机器人后可获得回复；需配置 API 凭证（consumerKey/consumerSecret、accessToken/accessTokenSecret）。
- **x-actions**：通过 message 工具执行 x-follow、x-unfollow、x-like、x-unlike、x-reply、x-dm，无需浏览器。
- **飞书内操作 X**：在飞书内可用自然语言（如「帮我关注 @xxx」）或斜杠命令（如 `/x follow @xxx`、`/x like <推文链接>`）触发 X 操作；需配置 `channels.feishu.xActionsAllowFrom`。
- **权限分离**：提及白名单（allowFrom / xActionsAllowFrom）与 X 操作白名单（actionsAllowFrom / xActionsAllowFrom）相互独立，勿混用。

### 1.5 大模型代理支持

支持为所有 LLM API 调用配置 HTTP 代理，方便在网络受限环境中使用：

```json
{
  "models": {
    "proxy": "http://user:pass@proxy:8080"
  }
}
```

### 1.6 OpenClaw 基础平台

QVerisBot 基于 [OpenClaw](https://github.com/openclaw/openclaw)（前身为 Clawdbot）开发，继承了其强大的平台能力：

- **本地优先的网关架构**：单一控制平面管理会话、渠道、工具和事件
- **多渠道支持**：连接多种即时通讯平台
- **多代理路由**：将入站消息路由到隔离的代理（独立工作区 + 会话）
- **语音交互**：支持 macOS/iOS/Android 的语音唤醒和对话模式
- **实时画布**：代理驱动的可视化工作区
- **一流的工具支持**：浏览器控制、画布、节点、定时任务等

---

## 2. 安装依赖

### 2.1 系统要求

| 组件 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 22.12.0 | 22.x LTS |
| Python | 3.12 | 3.12+ |
| pnpm | 10.x | 10.23.0+ |
| Git | 2.x | 最新版 |

### 2.2 macOS 安装

#### 2.2.1 安装 Homebrew（如果尚未安装）

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### 2.2.2 安装 Node.js 22+

```bash
# 方式一：使用 Homebrew
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 方式二：使用 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 22
nvm use 22
nvm alias default 22
```

#### 2.2.3 安装 pnpm

```bash
# 方式一：使用官方安装脚本（推荐）
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.zshrc

# 方式二：使用 npm 安装
npm install -g pnpm@latest

# 方式三：使用 Homebrew
brew install pnpm

# 验证安装
pnpm --version
```

#### 2.2.4 安装 Python 3.12+

```bash
# 使用 Homebrew
brew install python@3.12

# 验证安装
python3 --version
```

### 2.3 Linux 安装

以下示例基于 Ubuntu 24.04 LTS / Debian 12，其他发行版请参考对应的包管理器命令。

#### 2.3.1 更新系统包

```bash
sudo apt update && sudo apt upgrade -y
```

#### 2.3.2 安装 Node.js 22+

```bash
# 方式一：使用 NodeSource 仓库
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 方式二：使用 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
nvm alias default 22

# 验证安装
node --version  # 应显示 v22.x.x
npm --version
```

#### 2.3.3 安装 pnpm

```bash
# 方式一：使用官方安装脚本（推荐）
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.bashrc

# 方式二：使用 npm 安装
npm install -g pnpm@latest

# 验证安装
pnpm --version
```

#### 2.3.4 安装 Python 3.12+

```bash
# Ubuntu 24.04 自带 Python 3.12
# 对于旧版本系统，使用 deadsnakes PPA
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3.12-dev python3-pip

# 验证安装
python3.12 --version
```

#### 2.3.5 安装其他必要依赖

```bash
# 编译工具（部分 npm 包需要）
sudo apt install -y build-essential

# Git
sudo apt install -y git
```

### 2.4 Python 库依赖

QVerisBot 的 Python 测试脚本和技能（skills）使用以下库：

| 库名 | 版本 | 用途 |
|------|------|------|
| requests | 最新 | HTTP 请求（飞书 API 测试） |
| matplotlib | 最新 | 数据可视化、图表生成 |
| fastapi | >=0.110.0 | 技能服务框架 |
| httpx | >=0.27.0 | 异步 HTTP 客户端 |
| uvicorn | >=0.29.0 | ASGI 服务器 |
| pytest | >=8.0.0 | 测试框架（开发依赖） |

安装方式：

```bash
# 全局安装常用库
pip3 install requests matplotlib

# 技能开发依赖（可选）
pip3 install fastapi httpx uvicorn pytest
```

---

## 3. 飞书账号准备

飞书配置需要分两步完成：
1. **第一步**：完成除事件配置之外的所有配置
2. **第二步**：启动 QVerisBot 后，再配置事件订阅

### 3.1 申请飞书开发者账号

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 使用飞书账号登录（需要企业管理员权限或个人开发者账号）
3. 进入开发者后台

### 3.2 创建应用

1. 点击 **创建应用** → 选择 **企业自建应用**
2. 填写应用信息：
   - **应用名称**：如 "QVerisBot"
   - **应用描述**：AI 智能助手
   - **应用图标**：上传一个图标
3. 点击 **确定创建**

### 3.3 添加机器人能力

1. 进入应用详情页
2. 在左侧菜单选择 **添加应用能力**
3. 点击 **机器人** 卡片的 **添加能力**
4. 配置机器人信息：
   - **Bot Name**：机器人在聊天中显示的名称
   - **Bot Description**：机器人描述

### 3.4 配置权限

在 **权限管理** 页面，添加以下权限：

#### 消息与群组权限
| 权限名称 | 权限标识 | 说明 |
|---------|---------|------|
| 获取与发送单聊、群组消息 | im:message | 收发消息 |
| 获取群组信息 | im:chat:readonly | 读取群信息 |
| 获取与更新群组信息 | im:chat | 群组操作 |
| 以应用的身份发消息 | im:message:send_as_bot | 机器人发消息 |
| 获取用户发给机器人的单聊消息 | im:message.p2p_msg:readonly | 接收私聊 |
| 获取群组中所有消息 | im:message.group_msg:readonly | 接收群消息 |
| 获取消息中 @ 机器人的用户 | im:message.mention:readonly | 获取 @ 信息 |
| 上传图片或文件 | im:resource | 发送图片 |

#### 用户信息权限（可选）
| 权限名称 | 权限标识 | 说明 |
|---------|---------|------|
| 获取用户基本信息 | contact:user.base:readonly | 显示用户名 |

### 3.5 获取凭证

在 **凭证与基础信息** 页面获取：

- **App ID**：类似 `cli_xxxxxxxxxxxxxxxxxx`
- **App Secret**：点击查看获取密钥

> ⚠️ **安全提示**：App Secret 是敏感信息，请妥善保管，不要提交到版本控制系统。

### 3.6 发布应用（第一步完成后）

1. 进入 **版本管理与发布**
2. 创建版本
3. **设置可用范围**：
   - 在发布配置中，需要选择 **机器人的可用范围**
   - 点击 **添加用户** 或 **添加部门**，选择可以使用该机器人的用户
   - ⚠️ **重要**：只有被添加到可用范围内的用户才能将机器人添加到群聊中
4. 提交审核
5. 等待管理员审核通过
6. 发布应用

> 注意：应用需要发布后才能正常接收消息。开发阶段可以先在测试企业中使用。

### 3.7 事件订阅配置（第二步，需要先启动 QVerisBot）

> ⚠️ **重要**：此步骤需要在 QVerisBot 成功启动后才能完成，因为 QVerisBot 会启动飞书需要的 WebSocket 长连接监听进程。

在 **事件订阅** 页面：

1. **选择订阅方式**：选择 **使用长连接接收事件（推荐）**
   - 长连接模式无需公网 IP，本地开发更方便
   - QVerisBot 默认使用此模式

2. **添加事件**：
   | 事件名称 | 事件标识 |
   |---------|---------|
   | 接收消息 | im.message.receive_v1 |
   | 消息已读 | im.message.message_read_v1 |
   | 消息撤回 | im.message.recalled_v1 |
   | 机器人进群 | im.chat.member.bot.added_v1 |
   | 用户进入机器人单聊 | im.chat.access_event.bot_p2p_chat_entered_v1 |

3. 保存配置

---

## 4. 克隆代码

```bash
# 克隆 QVerisBot 仓库
git clone https://github.com/QVerisAI/QVerisBot.git
cd QVerisBot
```

---

## 5. 编译项目

### 5.1 安装依赖

```bash
# 安装所有 Node.js 依赖（包括扩展）
pnpm install
```

### 5.2 构建 UI（首次运行需要）

```bash
pnpm ui:build
```

### 5.3 编译 TypeScript

```bash
pnpm build
```

### 5.4 验证编译结果

```bash
# 检查 dist 目录是否生成
ls -la dist/

# 验证 CLI 可执行
pnpm openclaw --version
```

### 5.5 开发模式（可选）

如果需要在开发时自动重新编译：

```bash
# 监听文件变化并自动重启网关
pnpm gateway:watch
```

---

## 6. 配置

### 6.1 配置文件位置

QVerisBot 的配置文件位于 `~/.openclaw/openclaw.json`。

```bash
# 创建配置目录
mkdir -p ~/.openclaw
```

### 6.2 完整配置示例

创建配置文件 `~/.openclaw/openclaw.json`：

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
      "appId": "cli_xxxxxxxxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "eventMode": "websocket",
      "startupChatId": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxx",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "promptSuffix": "请用中文回答。"
    },
    "x": {
      "enabled": true,
      "consumerKey": "your-consumer-key",
      "consumerSecret": "your-consumer-secret",
      "accessToken": "your-access-token",
      "accessTokenSecret": "your-access-token-secret",
      "allowFrom": [],
      "actionsAllowFrom": []
    }
  },
  "tools": {
    "qveris": {
      "enabled": true,
      "apiKey": "your-qveris-api-key"
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

### 6.3 配置项详解

#### 6.3.1 Agent 配置

Agent 默认配置位于 `agents.defaults`，包括模型、工作区等：

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-opus-4-5" },
      "workspace": "~/clawd"
    }
  }
}
```

模型格式为 `provider/model-name`，例如：
- `anthropic/claude-opus-4-5`
- `openai/gpt-4o`
- `google/gemini-2.0-flash`

`model` 可配置主模型与回退：`"model": { "primary": "anthropic/claude-opus-4-5", "fallbacks": ["openai/gpt-4o"] }`。

#### 6.3.2 飞书配置

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "eventMode": "websocket",
      "startupChatId": "oc_xxx",
      "allowOnlyStartupChats": false,
      "dmPolicy": "open",
      "groupPolicy": "open",
      "requireMention": true,
      "groups": {
        "oc_xxx": {
          "requireMention": false,
          "systemPrompt": "你是这个群组的专属助手"
        }
      }
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|-------|------|--------|------|
| enabled | boolean | true | 是否启用飞书渠道 |
| appId | string | - | 飞书应用 App ID |
| appSecret | string | - | 飞书应用 App Secret |
| eventMode | string | "websocket" | 事件接收模式，推荐使用 "websocket" |
| startupChatId | string/string[] | - | **启动通知群组 ID**（详见下方说明） |
| allowOnlyStartupChats | boolean | false | 是否只允许 startupChatId 中的群组 |
| dmPolicy | string | "pairing" | 私聊策略：open/pairing/allowlist/disabled |
| groupPolicy | string | "open" | 群聊策略：open/allowlist/disabled |
| requireMention | boolean | true | 群聊是否需要 @机器人 |
| allowFrom | string[] | - | 允许的用户 ID 列表（私聊/提及权限） |
| xActionsAllowFrom | string[] | - | **X 操作白名单**：允许触发 X 操作（关注/点赞/回复/私信）的飞书用户 ID，勿与 allowFrom 混用 |
| groupAllowFrom | string[] | - | 允许的群组发送者列表 |
| promptSuffix | string | - | **提示词增强后缀**（详见下方说明） |
| actions | object | - | 飞书动作开关：reactions / sendMessage / deleteMessage / editMessage（默认 true） |
| tools | object | - | 飞书文档/知识库/云盘工具：doc / wiki / drive / perm（默认 doc/wiki/drive 为 true） |
| renderMode | string | "auto" | 回复渲染：auto（自动）/ raw（纯文本）/ card（卡片） |

##### startupChatId 配置说明

`startupChatId` 是飞书群组的唯一标识符，用于：
1. QVerisBot 启动时向该群组发送启动通知
2. 配合 `allowOnlyStartupChats: true` 可限制机器人只在指定群组中响应

**如何获取群组 ID (chat_id)**：

1. **方法一：通过飞书群设置获取**
   - 在飞书中打开目标群聊
   - 点击群名称进入群设置
   - 向下滚动找到 **群号**（即 chat_id），格式为 `oc_xxxxxxxxxxxxxxxxxx`

2. **方法二：通过机器人日志获取**
   - 先启动 QVerisBot（不配置 startupChatId）
   - 将机器人添加到目标群聊
   - 在群里 @机器人 发送一条消息
   - 查看 QVerisBot 日志，会显示类似：
     ```
     feishu: message context created - chatId=oc_xxxxxxxxxxxxxxxxxx, ...
     ```
   - 复制日志中的 `chatId` 值

3. **方法三：通过飞书开放平台 API**
   - 使用 [获取群列表 API](https://open.feishu.cn/document/server-docs/group/chat/list)
   - 或使用项目中的测试脚本：`python test_scripts/test_feishu_connection.py`

**配置示例**：

```json
{
  "channels": {
    "feishu": {
      "startupChatId": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxx",
      "allowOnlyStartupChats": false
    }
  }
}
```

支持配置多个群组：

```json
{
  "channels": {
    "feishu": {
      "startupChatId": ["oc_group1", "oc_group2", "oc_group3"]
    }
  }
}
```

##### promptSuffix 配置说明（提示词增强）

`promptSuffix` 用于在用户消息后自动附加一段文本，实现对用户请求的增强。这个功能可以：

1. 为所有用户请求添加统一的上下文或指导
2. 强制 AI 遵守特定的回复规范或格式
3. 针对不同群组设置不同的增强规则

**基本配置**（账户级别，对所有消息生效）：

```json
{
  "channels": {
    "feishu": {
      "promptSuffix": "请用中文回答。回答要简洁明了，重点突出。"
    }
  }
}
```

**群组级别配置**（覆盖账户级别设置）：

```json
{
  "channels": {
    "feishu": {
      "promptSuffix": "默认：请用中文回答。",
      "groups": {
        "oc_tech_group": {
          "promptSuffix": "这是一个技术讨论群。请提供代码示例，使用 Markdown 格式。"
        },
        "oc_sales_group": {
          "promptSuffix": "这是销售团队群组。请用简洁的商务语言回复，突出要点。"
        }
      }
    }
  }
}
```

**使用场景示例**：

| 场景 | promptSuffix 配置 |
|------|------------------|
| 中文回复 | `"请用中文回答。"` |
| 简洁回复 | `"请简洁回答，控制在200字以内。"` |
| 技术群组 | `"请提供代码示例和技术细节。"` |
| 客服场景 | `"请礼貌、专业地回复，提供详细的解决方案。"` |
| 数据分析 | `"请用表格或列表形式呈现数据，便于阅读。"` |

**注意事项**：

- 控制命令（如 `/status`、`/reset`）不会附加 promptSuffix
- 群组级别的 promptSuffix 会完全覆盖（而非追加）账户级别的设置
- 建议保持 promptSuffix 简洁，避免过长影响对话效率

##### xActionsAllowFrom 与飞书内触发 X 操作

在飞书中可通过自然语言或 `/x` 命令触发 X（Twitter）操作（关注、点赞、回复、私信）。只有列入 `channels.feishu.xActionsAllowFrom` 的飞书用户 ID 才有权限触发，与私聊/提及白名单 `allowFrom` 相互独立，请勿混用。

#### 6.3.3 X (Twitter) 渠道配置

X 渠道以插件形式提供，支持单账号与多账号。

**单账号配置**（凭证写在顶层）：

```json
{
  "channels": {
    "x": {
      "enabled": true,
      "consumerKey": "your-consumer-key",
      "consumerSecret": "your-consumer-secret",
      "accessToken": "your-access-token",
      "accessTokenSecret": "your-access-token-secret",
      "allowFrom": ["12345678"],
      "actionsAllowFrom": ["12345678"],
      "pollIntervalSeconds": 60,
      "proxy": "http://127.0.0.1:7890"
    }
  }
}
```

**多账号配置**（使用 `accounts`）：

```json
{
  "channels": {
    "x": {
      "enabled": true,
      "accounts": {
        "main": {
          "consumerKey": "...",
          "consumerSecret": "...",
          "accessToken": "...",
          "accessTokenSecret": "...",
          "allowFrom": ["12345678"],
          "actionsAllowFrom": ["12345678"]
        },
        "alt": {
          "consumerKey": "...",
          "consumerSecret": "...",
          "accessToken": "...",
          "accessTokenSecret": "..."
        }
      }
    }
  }
}
```

| 配置项 | 类型 | 说明 |
|-------|------|------|
| consumerKey / consumerSecret | string | 开发者门户 API Key / Secret |
| accessToken / accessTokenSecret | string | 账号 Access Token / Secret |
| allowFrom | string[] | 可 @ 机器人并得到回复的 X 用户 ID 白名单 |
| actionsAllowFrom | string[] | 可触发 X 操作（关注/点赞/回复/私信）的 X 用户 ID 白名单，勿与 allowFrom 混用 |
| pollIntervalSeconds | number | 轮询间隔（秒），最小 15 |
| proxy | string | API 请求的 HTTP 代理 URL |

#### 6.3.4 x-actions 技能与飞书 /x 命令

安装 X 扩展后，助手可通过 **message 工具的 X 动作** 执行：`x-follow`、`x-unfollow`、`x-like`、`x-unlike`、`x-reply`、`x-dm`。**请始终用 message 工具的 X 动作操作 X，不要用 browser 工具。**

在飞书内还可使用 **斜杠命令** 直接操作 X（由飞书消息处理，不经过 Agent）：

| 命令 | 说明 |
|------|------|
| `/x follow @用户名` | 关注该用户 |
| `/x unfollow @用户名` | 取消关注 |
| `/x like <推文链接>` | 点赞推文 |
| `/x unlike <推文链接>` | 取消点赞 |
| `/x dm @用户名 <消息>` | 发送私信 |
| `/x me` | 查看当前 X 账号信息 |

权限规则（两套白名单，勿混用）：
- **提及 → 回复**：X 用 `channels.x.allowFrom`，飞书用 `channels.feishu.allowFrom`
- **触发 X 操作**：X 用 `channels.x.actionsAllowFrom`，飞书用 `channels.feishu.xActionsAllowFrom`

#### 6.3.5 QVeris 配置

```json
{
  "tools": {
    "qveris": {
      "enabled": true,
      "apiKey": "your-qveris-api-key",
      "baseUrl": "https://qveris.ai/api/v1",
      "timeoutSeconds": 60,
      "maxResponseSize": 20480,
      "searchLimit": 10
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|-------|------|--------|------|
| enabled | boolean | true | 是否启用 QVeris 工具 |
| apiKey | string | - | QVeris API 密钥（也可通过 QVERIS_API_KEY 环境变量设置） |
| baseUrl | string | https://qveris.ai/api/v1 | QVeris API 地址 |
| timeoutSeconds | number | 60 | 请求超时时间（秒） |
| maxResponseSize | number | 20480 | 最大响应大小（字节） |
| searchLimit | number | 10 | 搜索结果数量限制 |

#### 6.3.6 大模型代理配置

```json
{
  "models": {
    "proxy": "http://user:pass@proxy:8080",
    "providers": {
      "custom-openai": {
        "baseUrl": "https://your-proxy.com/v1",
        "apiKey": "your-api-key",
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o via Proxy",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 2.5, "output": 10, "cacheRead": 1.25, "cacheWrite": 2.5 },
            "contextWindow": 128000,
            "maxTokens": 16384
          }
        ]
      }
    }
  }
}
```

#### 6.3.7 web_search 配置

默认的web_search是Brave Search，需要申请Apikey并产生费用。可以设置成使用QVeris的工具进行web search，有多个QVeris的工具可选，例如小宿的搜索工具，配置如下：

```json
    "tools": {
        "qveris": {
            "enabled": true,
            "apiKey": "your-qveris-api-key"
        },
        "web": {
            "search": {
                "enabled": true,
                "provider": "qveris",
                "qveris": {
                  "toolId": "xiaosu.smartsearch.search.retrieve.v2.6c50f296_domestic"
                }            
            }
        }
    }
```

### 6.4 环境变量配置

也可以通过环境变量配置敏感信息：

```bash
# 飞书凭证
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"

# QVeris API 密钥
export QVERIS_API_KEY="your-api-key"

# 大模型 API 密钥
export ANTHROPIC_API_KEY="sk-ant-xxx"
export OPENAI_API_KEY="sk-xxx"

# HTTP 代理（可选）
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"
```

建议将这些配置添加到 `~/.profile` 或 `~/.zshrc` 中。

---

## 7. 运行

### 7.1 首次运行（推荐使用向导）

```bash
# 运行安装向导
pnpm openclaw onboard --install-daemon
```

向导会引导你完成：
- 网关配置
- 工作区设置
- 渠道配置
- 技能安装

### 7.2 启动网关

```bash
# 前台运行（推荐开发时使用）
pnpm openclaw gateway --port 18789 --verbose

# 后台运行
nohup pnpm openclaw gateway --port 18789 > /tmp/openclaw-gateway.log 2>&1 &
```

### 7.3 验证运行状态

```bash
# 检查渠道状态
pnpm openclaw channels status

# 深度检查（包括连接探测）
pnpm openclaw channels status --deep

# 检查飞书连接
pnpm openclaw channels status feishu

# 检查 X 连接
pnpm openclaw channels status x
```

### 7.4 运行诊断

如果遇到问题，运行诊断工具：

```bash
pnpm openclaw doctor
```

### 7.5 飞书事件配置（第二步）

当网关成功启动并显示类似以下日志时：

```
feishu: connecting to Feishu WebSocket server...
feishu: WebSocket connection established
feishu: connected as "QVerisBot" (ou_xxx)
```

现在可以返回飞书开放平台完成 [3.7 事件订阅配置](#37-事件订阅配置第二步需要先启动-qverisbot)。

---

## 8. 使用说明

### 8.1 基本对话

在飞书中与机器人对话：

1. **私聊**：直接发送消息给机器人
2. **群聊**：@机器人 后发送消息（如果配置了 requireMention）

### 8.2 聊天命令

在飞书聊天中发送以下命令：

| 命令 | 说明 |
|------|------|
| `/status` | 查看会话状态（模型、token 数量、费用） |
| `/new` 或 `/reset` | 重置会话，清除历史记录 |
| `/compact` | 压缩会话上下文（生成摘要） |
| `/think <level>` | 设置思考级别：off/minimal/low/medium/high/xhigh |
| `/verbose on/off` | 开关详细模式 |
| `/usage off/tokens/full` | 设置使用量显示级别 |

### 8.3 X 操作与飞书 /x 命令

- **X 渠道**：在 X 上 @ 机器人后，助手可通过 message 工具的 x-follow、x-like、x-reply、x-dm 等动作执行操作；需在 `channels.x.allowFrom` 与 `channels.x.actionsAllowFrom` 中配置允许的用户 ID。
- **飞书内操作 X**：在飞书群聊或私聊中发送 `/x follow @用户名`、`/x like <推文链接>`、`/x dm @用户名 消息` 等，或使用自然语言（如「帮我关注 @elonmusk」），由助手调用 x-actions 执行；需在 `channels.feishu.xActionsAllowFrom` 中配置允许的飞书用户 ID。

### 8.4 使用 QVeris 工具

QVerisBot 会自动识别需要使用外部工具的场景。你也可以显式请求：

```
帮我查询一下北京今天的天气

搜索最新的 AI 技术新闻

查询腾讯股票的实时行情
```

### 8.5 CLI 命令

```bash
# 发送消息
pnpm openclaw message send --to oc_xxx --message "Hello from QVerisBot"

# 与助手对话
pnpm openclaw agent --message "帮我写一个 Python 脚本" --thinking high

# 查看帮助
pnpm openclaw --help
pnpm openclaw gateway --help
pnpm openclaw channels --help
```

### 8.6 日志查看

```bash
# 查看网关日志
tail -f /tmp/openclaw-gateway.log

# 开启详细日志运行
pnpm openclaw gateway --verbose

# 使用 debug 模式
DEBUG=* pnpm openclaw gateway
```

### 8.7 常见问题

#### Q: 飞书消息收不到？

1. 检查应用是否已发布
2. 检查权限是否正确配置
3. 确认 WebSocket 连接已建立（查看日志是否显示 "WebSocket connection established"）
4. 确认事件订阅已配置（在飞书开放平台的事件订阅页面）
5. 确认用户在应用的可用范围内（发布时设置的用户列表）
6. 检查 `startupChatId` 配置的群组 ID 是否正确

#### Q: QVeris 工具调用失败？

1. 检查 API 密钥是否正确
2. 检查网络连接（可能需要代理）
3. 查看日志中的错误信息

#### Q: 大模型 API 调用超时？

1. 配置 HTTP 代理：`models.proxy`
2. 检查代理服务是否正常工作
3. 尝试切换模型提供商

#### Q: X 操作提示 Permission denied？

1. 在 X 上触发：需在 `channels.x.actionsAllowFrom` 中配置你的 X 用户 ID
2. 在飞书内触发：需在 `channels.feishu.xActionsAllowFrom` 中配置你的飞书用户 ID
3. 勿将「提及白名单」（allowFrom）与「X 操作白名单」（actionsAllowFrom / xActionsAllowFrom）混用

---

## 附录

### A. 配置文件模板

完整配置文件模板：`~/.openclaw/openclaw.json`

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
      "startupChatId": ["oc_xxx"],
      "dmPolicy": "open",
      "groupPolicy": "open",
      "promptSuffix": "请用中文回答。",
      "allowFrom": [],
      "xActionsAllowFrom": [],
      "actions": {
        "reactions": true,
        "sendMessage": true,
        "deleteMessage": true,
        "editMessage": true
      },
      "tools": {
        "doc": true,
        "wiki": true,
        "drive": true,
        "perm": false
      },
      "renderMode": "auto",
      "groups": {
        "oc_xxx": {
          "requireMention": false,
          "promptSuffix": "这是技术讨论群，请提供代码示例。"
        }
      }
    },
    "x": {
      "enabled": true,
      "consumerKey": "your-consumer-key",
      "consumerSecret": "your-consumer-secret",
      "accessToken": "your-access-token",
      "accessTokenSecret": "your-access-token-secret",
      "allowFrom": [],
      "actionsAllowFrom": [],
      "pollIntervalSeconds": 60,
      "proxy": "http://127.0.0.1:7890"
    }
  },
  "tools": {
    "qveris": {
      "enabled": true,
      "apiKey": "your-qveris-api-key"
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

### B. 相关链接

- [QVeris AI](https://qveris.ai) - QVeris 万能工具箱
- [QVerisBot GitHub](https://github.com/QVerisAI/QVerisBot) - QVerisBot 源代码
- [OpenClaw 文档](https://docs.openclaw.ai) - 完整文档
- [飞书开放平台](https://open.feishu.cn) - 飞书开发者文档

### C. 获取帮助

- 查看文档：https://docs.openclaw.ai
- 提交 Issue：https://github.com/QVerisAI/QVerisBot/issues
- 加入 Discord：https://discord.gg/clawd

---

*本文档基于 QVerisBot 版本 2026.1.28-qveris.1 编写。*
