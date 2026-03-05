# OpenClaw MVP 重写设计方案

**作者**: Claude (Sonnet 4)
**日期**: 2026-03-05
**版本**: 1.0
**原项目**: [OpenClaw](https://github.com/openclaw/openclaw)

---

## 📋 目录

1. [执行摘要](#执行摘要)
2. [现有架构分析](#现有架构分析)
3. [MVP设计原则](#mvp设计原则)
4. [架构设计](#架构设计)
5. [技术栈选型](#技术栈选型)
6. [核心模块设计](#核心模块设计)
7. [数据模型](#数据模型)
8. [API设计](#api设计)
9. [开发路线图](#开发路线图)
10. [改进与创新](#改进与创新)
11. [风险与挑战](#风险与挑战)
12. [总结](#总结)

---

## 🎯 执行摘要

OpenClaw 是一个功能强大但复杂的本地AI助手平台，支持30+消息渠道、多平台客户端、插件系统等。本文档提出一个**简化的MVP重写方案**，保留核心价值，大幅降低复杂度，专注于**快速验证核心假设**。

### MVP核心目标

1. **单一消息渠道** (Telegram/Discord二选一)
2. **简化的LLM集成** (Claude API为主)
3. **基础对话管理** (会话隔离、历史记录)
4. **最小化部署** (单机版 + Docker容器)
5. **清晰的扩展路径** (为未来功能预留接口)

### 与原项目的主要差异

| 维度       | 原项目 OpenClaw                         | MVP 方案                      |
| ---------- | --------------------------------------- | ----------------------------- |
| 消息渠道   | 30+ (WhatsApp, Telegram, Discord等)     | **1-2个** (Telegram或Discord) |
| 客户端     | CLI + macOS App + iOS + Android + Web   | **CLI + Web UI**              |
| 插件系统   | 40+ 插件、Hook系统、SDK导出             | **无插件**，核心功能硬编码    |
| 模型支持   | Claude + GPT + Gemini + Ollama + 自定义 | **Claude API** (单一provider) |
| 会话策略   | 5种隔离策略 (per-peer, per-channel等)   | **固定策略** (per-user)       |
| 部署模式   | Gateway守护进程 + 多客户端 + 设备配对   | **单进程** HTTP/WS服务        |
| 代码量     | ~2000+ 文件, 69+ 子目录                 | **< 100 文件**，单repo        |
| 代码库规模 | 35K LOC单文件，21K LOC路由              | **< 10K LOC 总计**            |
| 开发周期   | 2+ 年演进                               | **2-4 周 MVP**                |

---

## 🔍 现有架构分析

### 优势

#### 1. 架构清晰分层

- Gateway → Routing → Channels → Agents → Storage
- 每层职责明确，降低耦合

#### 2. 强类型系统

- 全面的TypeScript类型覆盖
- Zod schema验证
- 无`any`类型使用

#### 3. 可扩展性设计

- 40+ 插件生态
- Hook系统允许行为修改
- Plugin SDK导出40+模块

#### 4. 安全默认值

- DM配对机制
- 工具沙箱执行
- 设备配对认证

#### 5. 多平台支持

- 跨平台CLI (Node.js)
- 原生macOS/iOS (SwiftUI)
- 原生Android (Compose)

#### 6. 本地优先

- 所有数据本地存储 (SQLite)
- 无第三方服务器依赖
- 隐私保护设计

### 痛点

#### 1. **过度工程化**

- 2000+ 文件，代码库巨大
- 单文件35K LOC (gateway/server.impl.ts)
- 新人学习曲线陡峭

#### 2. **复杂的路由逻辑**

- `dock.ts` 21K LOC单文件
- 5种会话隔离策略
- 复杂的提及/回复匹配规则

#### 3. **依赖过多**

- 40+ 插件依赖
- 多个AI SDK (Anthropic, OpenAI, Google)
- 多个消息SDK (Grammy, Discord.js, Baileys等)

#### 4. **配置复杂度**

- JSON5配置文件嵌套深
- 30+ 渠道配置选项
- 环境变量与配置文件混合

#### 5. **部署复杂**

- Gateway守护进程 + 客户端
- 设备配对流程
- 多平台构建流程 (Swift, Kotlin)

#### 6. **测试维护成本**

- 70%覆盖率目标
- Live测试需要真实credentials
- E2E测试需要Docker环境

---

## 🎯 MVP设计原则

### 核心原则

#### 1. **最小可行产品** (MVP)

- 仅实现核心价值路径
- 延迟所有非关键功能
- 快速迭代验证假设

#### 2. **简化优先**

- 避免过度抽象
- 硬编码可接受 (1-2个渠道)
- 延迟通用化

#### 3. **单一职责**

- 每个模块只做一件事
- 文件大小 < 500 LOC
- 清晰的模块边界

#### 4. **渐进式复杂度**

- 从最简单的实现开始
- 预留扩展点
- 不预先优化

#### 5. **Developer Experience (DX)**

- 清晰的项目结构
- 自文档化代码
- 完善的README

#### 6. **部署简单**

- 单一Docker镜像
- 最少配置项
- 一键启动

### 核心功能范围 (MoSCoW)

#### **Must Have** (必须有)

- ✅ 单一消息渠道集成 (Telegram 或 Discord)
- ✅ Claude API集成
- ✅ 基础对话管理 (会话创建、历史、上下文)
- ✅ 用户身份识别 (per-user会话隔离)
- ✅ 消息发送/接收
- ✅ Web UI管理界面
- ✅ CLI命令行工具
- ✅ 本地SQLite存储

#### **Should Have** (应该有)

- 🟡 多轮对话上下文管理
- 🟡 简单的工具调用 (1-2个工具: web_search, calculator)
- 🟡 基础日志记录
- 🟡 错误处理与重试
- 🟡 配置文件管理

#### **Could Have** (可以有)

- 🟠 第二个消息渠道
- 🟠 OpenAI GPT备用模型
- 🟠 Streaming响应
- 🟠 Docker Compose部署
- 🟠 基础权限控制 (allowlist)

#### **Won't Have** (不做)

- ❌ 插件系统
- ❌ 多平台客户端 (iOS/Android)
- ❌ 设备配对
- ❌ 语音输入
- ❌ Canvas渲染
- ❌ 多模型provider切换
- ❌ 复杂的会话策略
- ❌ 沙箱执行
- ❌ 自动更新

---

## 🏗️ 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend Layer                           │
├──────────────────────┬──────────────────────────────────────┤
│   CLI (Commander)    │   Web UI (React + Vite)             │
│   - 基础命令         │   - 对话界面                         │
│   - 配置管理         │   - 会话列表                         │
│   - 状态查看         │   - 设置页面                         │
└──────────┬───────────┴────────────────┬─────────────────────┘
           │                            │
           │  HTTP/REST API             │  WebSocket
           │                            │
┌──────────▼────────────────────────────▼─────────────────────┐
│                    API Gateway Layer                         │
│  - HTTP Server (Express)                                     │
│  - WebSocket Server (ws)                                     │
│  - Request Validation (Zod)                                  │
│  - Auth Middleware (Token-based)                             │
└──────────┬───────────────────────────┬─────────────────────┘
           │                           │
┌──────────▼──────────┐   ┌────────────▼─────────────────────┐
│  Channel Adapter    │   │    Chat Service                   │
│                     │   │                                   │
│  ┌────────────────┐│   │  - Session Manager                │
│  │ Telegram Bot   ││   │  - Message Router                 │
│  │  (Grammy)      ││   │  - Context Builder                │
│  └────────────────┘│   │  - Response Formatter             │
│                     │   └───────────────┬───────────────────┘
│  ┌────────────────┐│                   │
│  │ Discord Bot    ││                   │
│  │ (discord.js)   ││                   │
│  └────────────────┘│                   │
└──────────┬──────────┘                   │
           │                              │
           │  Inbound Messages            │  LLM Requests
           │                              │
┌──────────▼──────────────────────────────▼─────────────────┐
│                    Core Business Logic                     │
│                                                             │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Message Handler │  │ LLM Client   │  │ Tool Executor│ │
│  │                 │  │              │  │              │ │
│  │ - Parse         │  │ - Claude API │  │ - web_search │ │
│  │ - Validate      │  │ - Retry      │  │ - calculator │ │
│  │ - Route         │  │ - Error      │  │              │ │
│  └────────┬────────┘  └──────┬───────┘  └──────┬───────┘ │
│           │                  │                  │         │
└───────────┼──────────────────┼──────────────────┼─────────┘
            │                  │                  │
            │                  │                  │
┌───────────▼──────────────────▼──────────────────▼─────────┐
│                      Storage Layer                         │
│                                                             │
│  ┌────────────────────────────────────────────────────────┤
│  │  SQLite Database                                       │
│  │                                                         │
│  │  Tables:                                               │
│  │  - users       (id, platform_id, name, created_at)    │
│  │  - sessions    (id, user_id, context, updated_at)     │
│  │  - messages    (id, session_id, role, content, ts)    │
│  │  - config      (key, value)                            │
│  └─────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

### 数据流图

#### 用户发送消息流程

```
1. User sends message on Telegram
   │
   ▼
2. Grammy SDK receives update
   │
   ▼
3. Channel Adapter parses message
   │  - Extract: user_id, text, metadata
   │
   ▼
4. Message Handler validates & routes
   │  - Lookup or create user
   │  - Lookup or create session
   │
   ▼
5. Context Builder assembles prompt
   │  - Load recent message history (last 10)
   │  - Build system prompt
   │  - Format user message
   │
   ▼
6. LLM Client sends request to Claude API
   │  - Model: claude-sonnet-4-6
   │  - Max tokens: 4096
   │  - Temperature: 1.0
   │
   ▼
7. Tool Executor (if tool calls present)
   │  - Execute tools (web_search, calculator)
   │  - Append tool results
   │  - Send follow-up request to Claude
   │
   ▼
8. Response Formatter prepares reply
   │  - Extract final text
   │  - Format for channel (Markdown → platform-specific)
   │
   ▼
9. Channel Adapter sends reply
   │  - Telegram: bot.sendMessage()
   │
   ▼
10. Storage Layer persists
    - Save user message
    - Save assistant response
    - Update session metadata (last_active)
```

---

## 🛠️ 技术栈选型

### 后端

| 组件            | 技术选择                | 理由                     |
| --------------- | ----------------------- | ------------------------ |
| **Runtime**     | Node.js 22+             | 成熟生态，TypeScript友好 |
| **语言**        | TypeScript 5.9+         | 类型安全，维护性好       |
| **HTTP Server** | Express.js              | 简单、成熟、文档完善     |
| **WebSocket**   | `ws`                    | 轻量级、高性能           |
| **CLI**         | Commander.js            | 简单易用，足够MVP        |
| **数据库**      | SQLite (better-sqlite3) | 零配置，本地文件存储     |
| **Schema验证**  | Zod                     | 类型推断，运行时验证     |
| **消息渠道**    | Grammy (Telegram)       | 类型友好，API完善        |
| **LLM SDK**     | @anthropic-ai/sdk       | 官方SDK，streaming支持   |
| **工具SDK**     | Axios (web_search)      | 通用HTTP客户端           |
| **日志**        | pino                    | 高性能，结构化日志       |
| **配置**        | dotenv + Zod            | 简单环境变量管理         |

### 前端

| 组件          | 技术选择         | 理由                 |
| ------------- | ---------------- | -------------------- |
| **框架**      | React 18         | 生态成熟，组件丰富   |
| **状态管理**  | Zustand          | 轻量级，足够MVP      |
| **构建工具**  | Vite 6           | 快速启动，HMR        |
| **UI组件**    | Shadcn/ui        | 可定制，Tailwind风格 |
| **样式**      | Tailwind CSS     | 快速开发，响应式     |
| **WebSocket** | native WebSocket | 无需额外依赖         |
| **HTTP**      | fetch API        | 原生支持             |

### DevOps

| 组件       | 技术选择          | 理由           |
| ---------- | ----------------- | -------------- |
| **包管理** | pnpm              | 快速、节省空间 |
| **测试**   | Vitest            | 快速、Vite集成 |
| **Lint**   | ESLint + Prettier | 代码风格统一   |
| **容器化** | Docker            | 一致的部署环境 |
| **CI/CD**  | GitHub Actions    | 免费、集成好   |

### 依赖最小化原则

```json
{
  "dependencies": {
    // HTTP & WebSocket
    "express": "^5.0.0",
    "ws": "^8.18.0",
    "cors": "^2.8.5",

    // CLI
    "commander": "^12.0.0",

    // Database
    "better-sqlite3": "^11.0.0",

    // Validation
    "zod": "^3.23.0",

    // LLM
    "@anthropic-ai/sdk": "^0.30.0",

    // Messaging
    "grammy": "^1.27.0",

    // Utils
    "dotenv": "^16.4.0",
    "pino": "^9.0.0",
    "axios": "^1.7.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.4.0"
  }
}
```

**总依赖数**: < 15个直接依赖 (vs 原项目 100+)

---

## 🧩 核心模块设计

### 项目目录结构

```
openclaw-mvp/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── server.ts                   # Express + WebSocket server
│   ├── config.ts                   # Configuration loader
│   │
│   ├── channels/
│   │   ├── index.ts                # Channel registry
│   │   ├── telegram.ts             # Telegram adapter
│   │   └── types.ts                # Shared types
│   │
│   ├── chat/
│   │   ├── handler.ts              # Message handler
│   │   ├── session.ts              # Session manager
│   │   ├── context.ts              # Context builder
│   │   └── router.ts               # Message router
│   │
│   ├── llm/
│   │   ├── client.ts               # Claude API client
│   │   ├── tools.ts                # Tool definitions
│   │   └── executor.ts             # Tool executor
│   │
│   ├── storage/
│   │   ├── database.ts             # SQLite wrapper
│   │   ├── users.ts                # User repository
│   │   ├── sessions.ts             # Session repository
│   │   └── messages.ts             # Message repository
│   │
│   ├── api/
│   │   ├── routes/
│   │   │   ├── health.ts           # Health check
│   │   │   ├── chat.ts             # Chat endpoints
│   │   │   ├── sessions.ts         # Session management
│   │   │   └── config.ts           # Config endpoints
│   │   └── middleware/
│   │       ├── auth.ts             # Token validation
│   │       ├── error.ts            # Error handler
│   │       └── logger.ts           # Request logger
│   │
│   ├── cli/
│   │   ├── index.ts                # CLI entry point
│   │   ├── commands/
│   │   │   ├── start.ts            # Start server
│   │   │   ├── config.ts           # Config management
│   │   │   └── chat.ts             # Send message
│   │   └── utils.ts                # CLI helpers
│   │
│   └── utils/
│       ├── logger.ts               # Pino logger
│       ├── validation.ts           # Zod schemas
│       └── errors.ts               # Custom errors
│
├── web/                            # React frontend
│   ├── src/
│   │   ├── main.tsx                # React entry
│   │   ├── App.tsx                 # Root component
│   │   ├── components/
│   │   │   ├── ChatWindow.tsx      # Chat UI
│   │   │   ├── SessionList.tsx     # Session sidebar
│   │   │   └── Settings.tsx        # Settings panel
│   │   ├── store/
│   │   │   └── chat.ts             # Zustand store
│   │   └── api/
│   │       └── client.ts           # API wrapper
│   └── index.html
│
├── tests/
│   ├── unit/                       # Unit tests
│   ├── integration/                # Integration tests
│   └── fixtures/                   # Test data
│
├── scripts/
│   ├── migrate.ts                  # DB migration
│   └── seed.ts                     # Seed data
│
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

**总文件数**: ~50-80 (vs 原项目 2000+)

---

### 模块设计详解

#### 1. **Channel Adapter** (`src/channels/`)

**职责**: 统一不同消息平台的接口

```typescript
// src/channels/types.ts
export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(userId: string, text: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
}

export interface InboundMessage {
  channelId: string; // "telegram"
  platformUserId: string; // "123456789"
  userName: string; // "Alice"
  text: string;
  timestamp: Date;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;
```

```typescript
// src/channels/telegram.ts
import { Bot } from "grammy";
import { ChannelAdapter, InboundMessage, MessageHandler } from "./types";

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram";
  private bot: Bot;
  private handler?: MessageHandler;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async start() {
    this.bot.on("message:text", async (ctx) => {
      if (!this.handler) return;

      const msg: InboundMessage = {
        channelId: "telegram",
        platformUserId: String(ctx.from.id),
        userName: ctx.from.first_name,
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
      };

      await this.handler(msg);
    });

    await this.bot.start();
  }

  async stop() {
    await this.bot.stop();
  }

  async sendMessage(userId: string, text: string) {
    await this.bot.api.sendMessage(userId, text, {
      parse_mode: "Markdown",
    });
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }
}
```

#### 2. **Chat Handler** (`src/chat/handler.ts`)

**职责**: 处理消息，协调各组件

```typescript
import { InboundMessage } from "../channels/types";
import { SessionManager } from "./session";
import { ContextBuilder } from "./context";
import { LLMClient } from "../llm/client";
import { ToolExecutor } from "../llm/executor";
import { MessageRepository } from "../storage/messages";

export class MessageHandler {
  constructor(
    private sessions: SessionManager,
    private context: ContextBuilder,
    private llm: LLMClient,
    private tools: ToolExecutor,
    private messages: MessageRepository,
  ) {}

  async handle(msg: InboundMessage) {
    // 1. Get or create session
    const session = await this.sessions.getOrCreate(msg.channelId, msg.platformUserId);

    // 2. Save user message
    await this.messages.create({
      sessionId: session.id,
      role: "user",
      content: msg.text,
      timestamp: msg.timestamp,
    });

    // 3. Build context (system prompt + history)
    const messages = await this.context.build(session.id);

    // 4. Call LLM
    let response = await this.llm.chat(messages);

    // 5. Execute tools if needed
    if (response.toolCalls) {
      const toolResults = await this.tools.execute(response.toolCalls);
      response = await this.llm.chat([
        ...messages,
        { role: "assistant", content: response.text, tool_calls: response.toolCalls },
        ...toolResults.map((r) => ({ role: "tool", content: r.result })),
      ]);
    }

    // 6. Save assistant response
    await this.messages.create({
      sessionId: session.id,
      role: "assistant",
      content: response.text,
      timestamp: new Date(),
    });

    // 7. Update session
    await this.sessions.updateLastActive(session.id);

    return response.text;
  }
}
```

#### 3. **LLM Client** (`src/llm/client.ts`)

**职责**: 与Claude API交互

```typescript
import Anthropic from "@anthropic-ai/sdk";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  tool_calls?: ToolCall[];
}

export interface ChatResponse {
  text: string;
  toolCalls?: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class LLMClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const systemMessage = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemMessage?.content,
      messages: userMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      tools: this.getTools(),
    });

    return {
      text: response.content[0].type === "text" ? response.content[0].text : "",
      toolCalls: this.extractToolCalls(response),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private getTools() {
    return [
      {
        name: "web_search",
        description: "Search the web for information",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    ];
  }

  private extractToolCalls(response: any) {
    return response.content
      .filter((c: any) => c.type === "tool_use")
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        arguments: c.input,
      }));
  }
}
```

#### 4. **Storage Layer** (`src/storage/`)

**职责**: 数据持久化

```typescript
// src/storage/database.ts
import Database from "better-sqlite3";

export function initDatabase(path: string) {
  const db = new Database(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      user_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, platform_user_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      context_summary TEXT,
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);

  return db;
}
```

```typescript
// src/storage/messages.ts
import Database from "better-sqlite3";

export interface Message {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

export class MessageRepository {
  constructor(private db: Database.Database) {}

  create(msg: Omit<Message, "id">) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?)
    `);

    return stmt.run(msg.sessionId, msg.role, msg.content, msg.timestamp.toISOString());
  }

  getRecent(sessionId: number, limit = 10): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id as sessionId, role, content, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(sessionId, limit).map((row) => ({
      ...row,
      timestamp: new Date(row.timestamp),
    }));
  }
}
```

#### 5. **HTTP API** (`src/api/routes/`)

**职责**: Web UI 和 CLI 的 REST API

```typescript
// src/api/routes/chat.ts
import { Router } from "express";
import { z } from "zod";

const router = Router();

const SendMessageSchema = z.object({
  sessionId: z.number(),
  text: z.string().min(1),
});

router.post("/messages", async (req, res, next) => {
  try {
    const { sessionId, text } = SendMessageSchema.parse(req.body);

    const response = await req.app.locals.chatHandler.handle({
      channelId: "web",
      platformUserId: String(req.user.id),
      userName: req.user.name,
      text,
      timestamp: new Date(),
    });

    res.json({ success: true, response });
  } catch (error) {
    next(error);
  }
});

router.get("/sessions/:id/messages", async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id);
    const messages = await req.app.locals.messages.getRecent(sessionId, 50);

    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

export default router;
```

#### 6. **CLI** (`src/cli/`)

**职责**: 命令行工具

```typescript
// src/cli/index.ts
import { Command } from "commander";

const program = new Command();

program.name("openclaw-mvp").description("OpenClaw MVP CLI").version("0.1.0");

program
  .command("start")
  .description("Start the server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .action(async (options) => {
    const { startServer } = await import("../server");
    await startServer({ port: parseInt(options.port) });
  });

program
  .command("chat <message>")
  .description("Send a message to the assistant")
  .option("-s, --session <id>", "Session ID", "1")
  .action(async (message, options) => {
    const response = await fetch("http://localhost:3000/api/chat/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.API_TOKEN}`,
      },
      body: JSON.stringify({
        sessionId: parseInt(options.session),
        text: message,
      }),
    });

    const data = await response.json();
    console.log(data.response);
  });

program.parse();
```

---

## 📊 数据模型

### ER图

```
┌─────────────────────┐
│      users          │
├─────────────────────┤
│ id (PK)             │
│ channel_id          │◄──┐
│ platform_user_id    │   │
│ user_name           │   │
│ created_at          │   │
└─────────────────────┘   │
                          │
                          │ 1:N
                          │
┌─────────────────────┐   │
│     sessions        │───┘
├─────────────────────┤
│ id (PK)             │
│ user_id (FK)        │◄──┐
│ context_summary     │   │
│ last_active_at      │   │
│ created_at          │   │
└─────────────────────┘   │
                          │ 1:N
                          │
┌─────────────────────┐   │
│     messages        │───┘
├─────────────────────┤
│ id (PK)             │
│ session_id (FK)     │
│ role                │
│ content             │
│ timestamp           │
└─────────────────────┘
```

### 数据模型说明

#### `users` 表

- 存储跨渠道的用户身份
- `channel_id` + `platform_user_id` 唯一索引
- 同一用户在不同平台有不同记录

#### `sessions` 表

- 每个用户一个默认会话
- 可扩展为多会话支持
- `context_summary` 用于未来的上下文压缩

#### `messages` 表

- 存储所有对话历史
- `role` 区分用户/助手消息
- 按时间排序查询

---

## 🔌 API设计

### REST API

#### 基础路径

```
Base URL: http://localhost:3000/api
```

#### 认证

```
Authorization: Bearer <API_TOKEN>
```

#### 端点列表

##### 1. 健康检查

```http
GET /health
```

**响应**:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345
}
```

##### 2. 发送消息

```http
POST /chat/messages
Content-Type: application/json
Authorization: Bearer <token>

{
  "sessionId": 1,
  "text": "Hello, assistant!"
}
```

**响应**:

```json
{
  "success": true,
  "response": "Hello! How can I help you today?"
}
```

##### 3. 获取会话列表

```http
GET /sessions
Authorization: Bearer <token>
```

**响应**:

```json
{
  "sessions": [
    {
      "id": 1,
      "userId": 1,
      "lastActiveAt": "2026-03-05T10:00:00Z",
      "createdAt": "2026-03-01T08:00:00Z"
    }
  ]
}
```

##### 4. 获取消息历史

```http
GET /sessions/:id/messages?limit=50
Authorization: Bearer <token>
```

**响应**:

```json
{
  "messages": [
    {
      "id": 1,
      "sessionId": 1,
      "role": "user",
      "content": "What is 2+2?",
      "timestamp": "2026-03-05T10:00:00Z"
    },
    {
      "id": 2,
      "sessionId": 1,
      "role": "assistant",
      "content": "2+2 equals 4.",
      "timestamp": "2026-03-05T10:00:01Z"
    }
  ]
}
```

##### 5. 获取配置

```http
GET /config
Authorization: Bearer <token>
```

**响应**:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botUsername": "@mybot"
    }
  },
  "llm": {
    "model": "claude-sonnet-4-6",
    "maxTokens": 4096
  }
}
```

##### 6. 更新配置

```http
PATCH /config
Content-Type: application/json
Authorization: Bearer <token>

{
  "llm": {
    "maxTokens": 8192
  }
}
```

**响应**:

```json
{
  "success": true
}
```

### WebSocket API

#### 连接

```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "auth",
      token: "your-api-token",
    }),
  );
};
```

#### 消息格式

##### 客户端 → 服务器

**认证**:

```json
{
  "type": "auth",
  "token": "your-api-token"
}
```

**订阅会话**:

```json
{
  "type": "subscribe",
  "sessionId": 1
}
```

##### 服务器 → 客户端

**认证成功**:

```json
{
  "type": "auth_ok",
  "userId": 1
}
```

**新消息事件**:

```json
{
  "type": "message",
  "sessionId": 1,
  "message": {
    "id": 123,
    "role": "assistant",
    "content": "Hello!",
    "timestamp": "2026-03-05T10:00:00Z"
  }
}
```

**Streaming消息** (未来):

```json
{
  "type": "message_chunk",
  "sessionId": 1,
  "chunk": "Hello",
  "done": false
}
```

---

## 🗓️ 开发路线图

### Phase 1: 核心功能 (Week 1-2)

#### Sprint 1 (Week 1)

**目标**: 基础架构搭建

- [x] 项目初始化
  - 创建项目结构
  - 配置TypeScript、ESLint、Prettier
  - 配置Vitest测试框架

- [x] 数据库层
  - SQLite schema设计
  - Repository层实现 (users, sessions, messages)
  - 单元测试

- [x] LLM集成
  - Claude API client封装
  - 基础对话功能
  - 错误处理与重试

- [x] 配置管理
  - 环境变量加载
  - Zod schema验证
  - 配置文件读写

**交付物**:

- ✅ 基础代码框架
- ✅ 数据库可运行
- ✅ Claude API调用成功
- ✅ 测试覆盖率 > 60%

#### Sprint 2 (Week 2)

**目标**: 消息渠道集成

- [x] Telegram集成
  - Grammy Bot setup
  - 接收/发送消息
  - 用户识别与会话创建

- [x] 消息处理流程
  - Message Handler实现
  - Context Builder
  - Session Manager

- [x] HTTP Server
  - Express服务器搭建
  - REST API端点 (health, chat, sessions)
  - 认证中间件

- [x] CLI工具
  - Commander.js集成
  - start/chat命令
  - 配置管理命令

**交付物**:

- ✅ Telegram Bot可运行
- ✅ 端到端对话流程打通
- ✅ CLI可发送消息
- ✅ 测试覆盖率 > 70%

### Phase 2: Web UI (Week 3)

#### Sprint 3 (Week 3)

**目标**: Web管理界面

- [ ] React项目搭建
  - Vite + React 18
  - Tailwind CSS配置
  - Shadcn/ui组件

- [ ] 对话界面
  - ChatWindow组件
  - 消息列表渲染
  - 输入框与发送

- [ ] 会话管理
  - SessionList侧边栏
  - 创建/切换会话
  - 会话元数据显示

- [ ] WebSocket集成
  - 实时消息推送
  - 连接状态管理

- [ ] 设置页面
  - 配置编辑表单
  - 保存/重载配置

**交付物**:

- ✅ Web UI可访问
- ✅ 完整对话体验
- ✅ 实时消息更新
- ✅ 响应式设计

### Phase 3: 增强功能 (Week 4)

#### Sprint 4 (Week 4)

**目标**: 工具调用与优化

- [ ] 工具系统
  - web_search工具实现 (DuckDuckGo API)
  - calculator工具实现
  - Tool Executor

- [ ] 上下文管理
  - 消息历史截断 (token限制)
  - 上下文压缩 (简单summarize)

- [ ] 错误处理
  - 全局错误处理
  - 友好错误消息
  - 自动重试机制

- [ ] 日志系统
  - Pino结构化日志
  - 日志级别配置
  - 日志文件轮转

- [ ] Docker化
  - Dockerfile编写
  - docker-compose配置
  - 一键启动脚本

**交付物**:

- ✅ 工具调用功能可用
- ✅ 上下文管理优化
- ✅ 完善的错误处理
- ✅ Docker镜像可部署

### Phase 4: 测试与文档 (Week 4+)

#### Sprint 5 (Ongoing)

**目标**: 稳定性与可维护性

- [ ] 测试完善
  - 集成测试覆盖关键流程
  - E2E测试 (可选)
  - 性能测试基准

- [ ] 文档编写
  - README (快速开始、部署指南)
  - API文档 (REST + WebSocket)
  - 架构文档 (本文档)
  - 故障排查指南

- [ ] CI/CD
  - GitHub Actions配置
  - 自动化测试
  - Docker镜像发布

- [ ] 用户反馈
  - Alpha测试
  - 收集反馈
  - 迭代优化

**交付物**:

- ✅ 测试覆盖率 > 80%
- ✅ 完整文档
- ✅ CI/CD流水线
- ✅ MVP可发布

---

## 💡 改进与创新

### 相比原项目的改进

#### 1. **极简主义设计**

- **原项目**: 2000+ 文件，35K LOC单文件
- **MVP**: < 100 文件，< 10K LOC总计
- **优势**: 易于理解、快速上手、低维护成本

#### 2. **单一职责原则**

- **原项目**: Gateway承担过多职责 (35K LOC)
- **MVP**: 模块化设计，每个文件 < 500 LOC
- **优势**: 更好的可测试性、更清晰的依赖关系

#### 3. **配置简化**

- **原项目**: JSON5嵌套配置 + 30+ 渠道选项
- **MVP**: .env + 最小配置项
- **优势**: 零学习成本、减少配置错误

#### 4. **部署简单**

- **原项目**: Gateway守护进程 + 多客户端 + 设备配对
- **MVP**: 单进程 + Docker一键启动
- **优势**: 降低运维复杂度、快速部署

#### 5. **依赖最小化**

- **原项目**: 100+ 依赖，多个AI SDK
- **MVP**: < 15 直接依赖，单一LLM provider
- **优势**: 减少安全风险、加快安装速度

### 创新功能设想 (未来扩展)

#### 1. **插件系统重新设计**

- **原项目问题**: 40+ 插件，复杂的Hook系统
- **新设计**: 简化插件接口，约定优于配置
  ```typescript
  interface SimplePlugin {
    name: string;
    version: string;
    init(context: PluginContext): Promise<void>;
    onMessage?(msg: Message): Promise<Message>;
    tools?: ToolDefinition[];
  }
  ```
- **优势**: 降低插件开发门槛、易于社区贡献

#### 2. **智能上下文管理**

- **原项目**: 简单的token截断
- **新设计**: 基于相关性的上下文选择
  - 使用embedding计算消息相关性
  - 保留最相关的历史消息
  - 自动总结长对话
- **优势**: 提高回复质量、节省API费用

#### 3. **多模型路由**

- **原项目**: 单一模型或手动切换
- **新设计**: 根据任务自动选择模型
  - 简单问题 → Claude Haiku (快速+便宜)
  - 复杂任务 → Claude Opus (高质量)
  - 代码生成 → 特定模型
- **优势**: 平衡成本与质量

#### 4. **渐进式Web UI**

- **原项目**: 传统Web UI
- **新设计**: PWA (Progressive Web App)
  - 离线支持
  - 移动端安装
  - 推送通知
- **优势**: 类原生体验、跨平台

#### 5. **对话分析仪表板**

- **原项目**: 无
- **新设计**: 可视化对话数据
  - 消息量统计
  - Token使用趋势
  - 常见问题分类
  - 工具调用频率
- **优势**: 帮助用户了解使用习惯、优化配置

---

## ⚠️ 风险与挑战

### 技术风险

#### 1. **单一LLM依赖**

- **风险**: Claude API不可用或限流
- **缓解**:
  - 实现指数退避重试
  - 保留OpenAI GPT作为备用
  - 缓存常见问题回复

#### 2. **SQLite并发限制**

- **风险**: 多用户写入冲突
- **缓解**:
  - MVP阶段用户量小，不是问题
  - 未来可迁移至PostgreSQL
  - 使用WAL模式提升并发

#### 3. **消息SDK稳定性**

- **风险**: Grammy或Discord.js API变动
- **缓解**:
  - 锁定依赖版本
  - 适配层抽象SDK细节
  - 监控SDK更新

#### 4. **工具执行安全**

- **风险**: web_search返回恶意内容
- **缓解**:
  - 工具输出sanitization
  - 限制工具执行频率
  - 用户allowlist机制

### 产品风险

#### 1. **用户需求验证**

- **风险**: MVP功能不满足核心需求
- **缓解**:
  - 早期用户访谈
  - Alpha测试收集反馈
  - 快速迭代调整

#### 2. **竞品压力**

- **风险**: 类似产品抢占市场
- **缓解**:
  - 强调本地优先、隐私保护
  - 社区驱动开发
  - 插件生态差异化

#### 3. **商业化路径**

- **风险**: 开源项目难以盈利
- **缓解**:
  - 托管服务 (SaaS版本)
  - 企业支持订阅
  - 高级功能付费

### 开发风险

#### 1. **时间估算偏差**

- **风险**: 4周完成MVP过于乐观
- **缓解**:
  - 严格范围控制 (MoSCoW)
  - 延迟非关键功能
  - 定期review进度

#### 2. **技术债务累积**

- **风险**: 快速开发导致代码质量下降
- **缓解**:
  - 代码review制度
  - 测试覆盖率守护
  - 定期重构

#### 3. **文档滞后**

- **风险**: 文档与代码不同步
- **缓解**:
  - 文档作为PR checklist
  - 自动化API文档生成
  - 社区贡献审查

---

## 🎓 总结

### MVP设计核心思想

1. **Less is More**: 从最简单的实现开始，延迟所有非必要复杂度
2. **Layered Growth**: 预留扩展点，允许渐进式增加功能
3. **Developer First**: 优秀的DX (开发者体验) 是成功的关键
4. **User Focused**: 专注核心价值 (对话质量)，其他都是辅助

### 成功指标

#### 定量指标

- ✅ 4周内完成MVP
- ✅ 代码量 < 10K LOC
- ✅ 测试覆盖率 > 70%
- ✅ 端到端延迟 < 3秒
- ✅ Docker镜像 < 500MB

#### 定性指标

- ✅ 新人30分钟内搭建完成
- ✅ 对话体验流畅自然
- ✅ 配置简单直观
- ✅ 错误消息友好易懂
- ✅ 文档完善易查

### 下一步行动

#### 立即开始 (Week 1)

1. **项目初始化**

   ```bash
   mkdir openclaw-mvp
   cd openclaw-mvp
   pnpm init
   pnpm add typescript @types/node -D
   pnpm add express grammy @anthropic-ai/sdk better-sqlite3
   ```

2. **数据库设计**
   - 编写SQL schema
   - 实现Repository层
   - 编写单元测试

3. **LLM集成**
   - 实现LLMClient
   - 测试API连接
   - 错误处理

#### 短期目标 (Week 2-4)

- Week 2: Telegram集成 + HTTP API
- Week 3: Web UI开发
- Week 4: 工具系统 + Docker化

#### 长期愿景 (Month 2+)

- 第二个消息渠道 (Discord)
- 插件系统设计
- 多模型支持
- 移动客户端 (PWA)
- 社区运营

### 关键成功因素

1. **范围纪律**: 严格遵守MVP范围，拒绝feature creep
2. **质量优先**: 即使是MVP，代码质量和测试不能妥协
3. **快速反馈**: 尽早发布Alpha，收集用户反馈
4. **文档同步**: 文档与代码同步更新
5. **社区驱动**: 开源后积极响应社区需求

### 最后的话

OpenClaw是一个优秀的项目，展示了如何构建一个功能完整的AI助手平台。但对于MVP和初创团队，**从简单开始、快速验证、渐进式演进**才是更合理的路径。

这份设计方案的目标是：**用20%的努力，实现80%的核心价值**。

让我们开始构建吧！🚀

---

## 📚 附录

### A. 技术选型对比

| 技术        | 选择          | 备选方案        | 理由          |
| ----------- | ------------- | --------------- | ------------- |
| Runtime     | Node.js       | Deno, Bun       | 生态成熟度    |
| 语言        | TypeScript    | JavaScript      | 类型安全      |
| HTTP Server | Express       | Fastify, Hono   | 简单、文档全  |
| Database    | SQLite        | PostgreSQL      | 零配置        |
| ORM         | 无 (Raw SQL)  | Prisma, Drizzle | 减少抽象层    |
| 消息渠道    | Grammy        | Telegraf        | 类型友好      |
| LLM SDK     | Anthropic SDK | LangChain       | 简洁、官方    |
| Frontend    | React         | Vue, Svelte     | 生态丰富      |
| State       | Zustand       | Redux, Jotai    | 轻量级        |
| 测试        | Vitest        | Jest            | 快速、ESM支持 |

### B. 配置文件示例

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
API_TOKEN=your-secret-token
DATABASE_PATH=./data/openclaw.db
PORT=3000
LOG_LEVEL=info
```

```json5
// config.json (可选)
{
  llm: {
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    temperature: 1.0,
  },
  chat: {
    maxHistoryMessages: 10,
    contextWindow: 200000,
  },
  channels: {
    telegram: {
      enabled: true,
      allowedUsers: ["123456789"], // 可选
    },
  },
}
```

### C. Docker Compose示例

```yaml
# docker-compose.yml
version: "3.9"

services:
  openclaw-mvp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - API_TOKEN=${API_TOKEN}
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

### D. 测试示例

```typescript
// tests/unit/llm/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { LLMClient } from "../../../src/llm/client";

describe("LLMClient", () => {
  it("should send a message and receive a response", async () => {
    const client = new LLMClient("test-api-key");

    // Mock Anthropic SDK
    vi.mock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "Hello!" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        };
      },
    }));

    const response = await client.chat([{ role: "user", content: "Hi" }]);

    expect(response.text).toBe("Hello!");
    expect(response.usage.inputTokens).toBe(10);
  });
});
```

### E. 参考资源

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Claude API文档](https://docs.anthropic.com/)
- [Grammy文档](https://grammy.dev/)
- [Express文档](https://expressjs.com/)
- [Zod文档](https://zod.dev/)

---

**文档版本**: 1.0
**最后更新**: 2026-03-05
**作者**: Claude (Sonnet 4)
**License**: MIT
