# Commands 核心模块详解

> Commands 是用户与 OpenClaw 交互的主要方式，包括 CLI 命令和聊天命令。

## 目录

1. [Commands 概述](#commands-概述)
2. [CLI 命令](#cli-命令)
3. [聊天命令](#聊天命令)
4. [命令解析](#命令解析)
5. [命令开发](#命令开发)

---

## Commands 概述

### 命令类型

```
Commands
│
├── CLI 命令 (命令行)
│   ├── openclaw gateway start
│   ├── openclaw agents list
│   ├── openclaw channels status
│   └── ...
│
└── 聊天命令 (通过消息)
    ├── /help - 帮助
    ├── /status - 状态
    ├── /model - 切换模型
    └── ...
```

---

## CLI 命令

### 命令结构

```bash
openclaw <category> <action> [options]

示例：
openclaw gateway start --port 8080
openclaw agents list --active
openclaw channels status qqbot
```

### 常用命令

#### Gateway 管理
```bash
openclaw gateway start      # 启动
openclaw gateway stop       # 停止
openclaw gateway restart    # 重启
openclaw gateway status     # 状态
openclaw gateway logs       # 日志
```

#### Agent 管理
```bash
openclaw agents list        # 列表
openclaw agents show main   # 详情
openclaw agents add dev     # 添加
openclaw agents delete dev  # 删除
```

#### Channel 管理
```bash
openclaw channels list          # 列表
openclaw channels status qqbot  # 状态
openclaw channels restart tg    # 重启
```

#### 会话管理
```bash
openclaw sessions list          # 列表
openclaw sessions show <key>    # 详情
openclaw sessions clear <key>   # 清除
```

---

## 聊天命令

### 命令格式

```
/命令名 [参数]

示例：
/help
/status
/model qwen3.5-plus
```

### 常用聊天命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `/help` | 显示帮助 | `/help` |
| `/status` | 查看状态 | `/status` |
| `/model` | 切换模型 | `/model qwen3.5-plus` |
| `/sessions` | 查看会话 | `/sessions` |
| `/clear` | 清除上下文 | `/clear` |
| `/export` | 导出对话 | `/export pdf` |

---

## 命令解析

### 解析流程

```
用户输入
    │
    ▼
命令识别 (是否以/开头？)
    │
    ├─ 是 → 解析命令
    │      │
    │      ▼
    │   参数解析
    │      │
    │      ▼
    │   执行命令
    │
    └─ 否 → 作为普通消息处理
```

### 命令权限

```json5
{
  "commands": {
    "gating": {
      "gateway": "owner",      // gateway 命令仅所有者
      "agents": "admin",       // agents 命令管理员
      "sessions": "user",      // sessions 命令用户
      "*": "all"               // 其他命令所有人
    }
  }
}
```

---

## 命令开发

### 创建新命令

```typescript
// commands/my-command.ts
import { defineCommand } from "openclaw/cli";

export const myCommand = defineCommand({
  name: "my-command",
  description: "我的命令",
  args: [
    { name: "input", type: "string", required: true }
  ],
  async run(args, ctx) {
    // 命令逻辑
    console.log(`Input: ${args.input}`);
  }
});
```

### 注册命令

```typescript
// commands/index.ts
export { myCommand } from "./my-command";

export const commands = [
  myCommand,
  // ...其他命令
];
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
