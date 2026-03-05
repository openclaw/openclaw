# OpenClaw MVP 开发计划

**简化版开发路线图** | 2026-03-05

---

## 📅 总览

| 阶段        | 时间    | 核心目标     | 交付物           |
| ----------- | ------- | ------------ | ---------------- |
| **Phase 0** | Day 1-2 | 项目搭建     | 可运行的基础框架 |
| **Phase 1** | Week 1  | 数据库+LLM   | 对话功能核心逻辑 |
| **Phase 2** | Week 2  | 消息渠道+API | Telegram Bot可用 |
| **Phase 3** | Week 3  | Web UI       | 完整Web管理界面  |
| **Phase 4** | Week 4  | 工具+部署    | 生产可用的MVP    |

**总计**: 4周 (28天) → 可部署的MVP产品

---

## Phase 0: 项目初始化 (Day 1-2)

### 🎯 目标

搭建项目骨架，配置开发环境

### 📦 技术栈

```json
{
  "runtime": "Node.js 22+",
  "language": "TypeScript 5.9+",
  "package-manager": "pnpm",
  "testing": "Vitest",
  "linting": "ESLint + Prettier"
}
```

### ✅ 任务清单

- [ ] **项目初始化**

  ```bash
  mkdir openclaw-mvp && cd openclaw-mvp
  pnpm init
  ```

- [ ] **安装依赖**

  ```bash
  # 核心依赖
  pnpm add express ws better-sqlite3 @anthropic-ai/sdk grammy zod pino dotenv commander

  # 类型定义
  pnpm add -D @types/node @types/express @types/ws @types/better-sqlite3

  # 开发工具
  pnpm add -D typescript tsx vitest eslint prettier
  ```

- [ ] **配置文件**
  - `tsconfig.json` - TypeScript配置
  - `eslint.config.js` - 代码检查
  - `.prettierrc` - 代码格式化
  - `vitest.config.ts` - 测试配置

- [ ] **目录结构**

  ```
  src/
  ├── api/          # HTTP API
  ├── channels/     # 消息渠道
  ├── chat/         # 对话逻辑
  ├── cli/          # 命令行工具
  ├── llm/          # LLM集成
  ├── storage/      # 数据库
  └── utils/        # 工具函数
  ```

- [ ] **开发脚本**
  ```json
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest",
    "lint": "eslint src",
    "format": "prettier --write src"
  }
  ```

### 📊 交付标准

✅ `pnpm dev` 可以运行（即使只是打印 "Hello World"）
✅ `pnpm test` 可以执行测试
✅ TypeScript 编译无错误

---

## Phase 1: 核心逻辑层 (Week 1: Day 3-9)

### 🎯 目标

实现数据存储和LLM对话功能

### 📦 技术栈

| 模块       | 技术              | 用途           |
| ---------- | ----------------- | -------------- |
| **数据库** | better-sqlite3    | 本地SQLite存储 |
| **ORM**    | 无 (原生SQL)      | 简化依赖       |
| **LLM**    | @anthropic-ai/sdk | Claude API     |
| **验证**   | Zod               | 数据校验       |
| **日志**   | Pino              | 结构化日志     |

### ✅ 任务清单

#### Day 3-4: 数据库层

- [ ] **Schema设计** (`src/storage/database.ts`)

  ```sql
  -- 用户表
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    channel_id TEXT,
    platform_user_id TEXT,
    user_name TEXT,
    created_at DATETIME
  );

  -- 会话表
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    last_active_at DATETIME
  );

  -- 消息表
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER,
    role TEXT CHECK(role IN ('user', 'assistant')),
    content TEXT,
    timestamp DATETIME
  );
  ```

- [ ] **Repository层**
  - `UserRepository` - 用户CRUD
  - `SessionRepository` - 会话管理
  - `MessageRepository` - 消息存储

- [ ] **单元测试**
  - 测试数据库初始化
  - 测试CRUD操作
  - 测试索引查询

#### Day 5-7: LLM集成

- [ ] **LLMClient** (`src/llm/client.ts`)

  ```typescript
  interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
  }

  class LLMClient {
    async chat(messages: ChatMessage[]): Promise<string>;
  }
  ```

- [ ] **错误处理**
  - API限流处理 (429)
  - 网络错误重试
  - Token超限处理

- [ ] **配置管理** (`src/config.ts`)
  ```typescript
  export const config = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    databasePath: process.env.DATABASE_PATH || "./data/openclaw.db",
    // ...
  };
  ```

#### Day 8-9: 对话逻辑

- [ ] **SessionManager** (`src/chat/session.ts`)
  - 获取或创建会话
  - 更新最后活跃时间

- [ ] **ContextBuilder** (`src/chat/context.ts`)
  - 构建系统提示词
  - 加载历史消息 (最近10条)
  - 组装完整上下文

- [ ] **MessageHandler** (`src/chat/handler.ts`)
  - 接收消息 → 存储
  - 构建上下文 → 调用LLM
  - 保存回复 → 返回

- [ ] **集成测试**
  - 端到端对话流程
  - 多轮对话上下文

### 📊 交付标准

✅ 数据库可以正常读写
✅ Claude API可以成功调用
✅ 完整的对话流程可以在单元测试中运行
✅ 测试覆盖率 > 60%

---

## Phase 2: 接入层 (Week 2: Day 10-16)

### 🎯 目标

实现Telegram Bot和HTTP API

### 📦 技术栈

| 模块            | 技术         | 用途             |
| --------------- | ------------ | ---------------- |
| **消息渠道**    | Grammy       | Telegram Bot框架 |
| **HTTP Server** | Express      | REST API服务     |
| **WebSocket**   | ws           | 实时通信         |
| **CLI**         | Commander.js | 命令行工具       |

### ✅ 任务清单

#### Day 10-12: Telegram集成

- [ ] **TelegramAdapter** (`src/channels/telegram.ts`)

  ```typescript
  class TelegramAdapter implements ChannelAdapter {
    async start(): Promise<void>; // 启动Bot
    async stop(): Promise<void>; // 停止Bot
    async sendMessage(userId, text); // 发送消息
    onMessage(handler: MessageHandler); // 接收消息
  }
  ```

- [ ] **消息处理流程**

  ```
  Telegram消息 → TelegramAdapter
    → MessageHandler.handle()
    → TelegramAdapter.sendMessage()
  ```

- [ ] **用户识别**
  - 从 `telegram.User` 提取 userId
  - 创建或更新用户记录

- [ ] **错误处理**
  - Bot启动失败处理
  - 消息发送失败重试
  - 用户友好的错误提示

#### Day 13-14: HTTP API

- [ ] **Server搭建** (`src/server.ts`)

  ```typescript
  const app = express();
  app.use(express.json());
  app.use("/api/health", healthRouter);
  app.use("/api/chat", authMiddleware, chatRouter);
  app.use("/api/sessions", authMiddleware, sessionsRouter);
  ```

- [ ] **API端点**
  - `GET /api/health` - 健康检查
  - `POST /api/chat/messages` - 发送消息
  - `GET /api/sessions` - 会话列表
  - `GET /api/sessions/:id/messages` - 消息历史

- [ ] **认证中间件**

  ```typescript
  // Bearer Token验证
  Authorization: Bearer<API_TOKEN>;
  ```

- [ ] **WebSocket** (基础版)
  - 连接认证
  - 实时消息推送 (可选)

#### Day 15-16: CLI工具

- [ ] **命令实现** (`src/cli/index.ts`)

  ```bash
  openclaw-mvp start              # 启动服务
  openclaw-mvp chat "Hello"       # 发送消息
  openclaw-mvp config set <key>   # 配置管理
  openclaw-mvp status             # 查看状态
  ```

- [ ] **服务启动逻辑**
  ```typescript
  program
    .command("start")
    .option("-p, --port <port>", "Port number")
    .action(async (options) => {
      await startServer(options);
    });
  ```

### 📊 交付标准

✅ Telegram Bot可以正常接收和回复消息
✅ HTTP API所有端点可用
✅ CLI命令可以执行
✅ 完整的集成测试通过
✅ 测试覆盖率 > 70%

---

## Phase 3: 前端界面 (Week 3: Day 17-23)

### 🎯 目标

开发Web管理界面

### 📦 技术栈

| 模块           | 技术         | 用途         |
| -------------- | ------------ | ------------ |
| **框架**       | React 18     | UI框架       |
| **构建工具**   | Vite 6       | 开发/构建    |
| **状态管理**   | Zustand      | 轻量状态管理 |
| **UI组件**     | Shadcn/ui    | 组件库       |
| **样式**       | Tailwind CSS | CSS框架      |
| **HTTP客户端** | fetch        | 原生API      |

### ✅ 任务清单

#### Day 17-18: 项目搭建

- [ ] **初始化React项目**

  ```bash
  cd openclaw-mvp
  pnpm create vite@latest web -- --template react-ts
  cd web
  pnpm install
  ```

- [ ] **配置Tailwind**

  ```bash
  pnpm add -D tailwindcss postcss autoprefixer
  pnpm tailwindcss init -p
  ```

- [ ] **安装Shadcn/ui**

  ```bash
  pnpm add class-variance-authority clsx tailwind-merge
  pnpx shadcn@latest init
  ```

- [ ] **目录结构**
  ```
  web/src/
  ├── components/
  │   ├── ChatWindow.tsx
  │   ├── SessionList.tsx
  │   └── Settings.tsx
  ├── store/
  │   └── chat.ts
  ├── api/
  │   └── client.ts
  └── App.tsx
  ```

#### Day 19-20: 核心组件

- [ ] **ChatWindow** - 聊天界面

  ```typescript
  -消息列表(滚动到底部) - 输入框 - 发送按钮 - 加载状态;
  ```

- [ ] **SessionList** - 会话列表

  ```typescript
  -会话列表渲染 - 当前激活会话高亮 - 切换会话 - 创建新会话按钮;
  ```

- [ ] **API Client** (`api/client.ts`)
  ```typescript
  export const api = {
    sendMessage: async (sessionId, text) => {
      /*...*/
    },
    getSessions: async () => {
      /*...*/
    },
    getMessages: async (sessionId) => {
      /*...*/
    },
  };
  ```

#### Day 21-22: 状态管理+集成

- [ ] **Zustand Store** (`store/chat.ts`)

  ```typescript
  interface ChatStore {
    sessions: Session[];
    currentSessionId: number | null;
    messages: Message[];
    loadSessions: () => Promise<void>;
    loadMessages: (sessionId: number) => Promise<void>;
    sendMessage: (text: string) => Promise<void>;
  }
  ```

- [ ] **WebSocket集成** (可选)

  ```typescript
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:3000/ws");
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "message") {
        addMessage(msg.message);
      }
    };
  }, []);
  ```

- [ ] **响应式设计**
  - 移动端适配
  - 侧边栏折叠
  - 深色模式 (可选)

#### Day 23: 设置页面

- [ ] **Settings组件**
  ```typescript
  - LLM配置 (model, maxTokens)
  - 对话配置 (maxHistoryMessages)
  - API Token显示
  - 保存按钮
  ```

### 📊 交付标准

✅ Web UI可以访问 (http://localhost:5173)
✅ 可以发送消息并接收回复
✅ 会话列表和切换功能正常
✅ 响应式设计在移动端可用
✅ 所有API调用正常

---

## Phase 4: 增强+部署 (Week 4: Day 24-28)

### 🎯 目标

实现工具调用、Docker化、完善文档

### 📦 技术栈

| 模块         | 技术           | 用途       |
| ------------ | -------------- | ---------- |
| **工具系统** | Axios          | HTTP请求   |
| **容器化**   | Docker         | 部署       |
| **编排**     | Docker Compose | 多容器管理 |
| **文档**     | Markdown       | README     |

### ✅ 任务清单

#### Day 24-25: 工具系统

- [ ] **Tool定义** (`src/llm/tools.ts`)

  ```typescript
  export const tools = [
    {
      name: "web_search",
      description: "Search the web",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    },
  ];
  ```

- [ ] **ToolExecutor** (`src/llm/executor.ts`)

  ```typescript
  class ToolExecutor {
    async execute(toolCalls: ToolCall[]): Promise<ToolResult[]> {
      // web_search: DuckDuckGo API
      // calculator: eval() with sanitization
    }
  }
  ```

- [ ] **集成到对话流程**
  ```typescript
  // 1. LLM回复包含tool_calls
  // 2. 执行工具
  // 3. 将结果作为tool_result发送给LLM
  // 4. 获取最终回复
  ```

#### Day 26: 优化+测试

- [ ] **性能优化**
  - 数据库连接池
  - LLM响应缓存 (简单版)
  - Rate limiting

- [ ] **错误处理完善**
  - 全局错误处理器
  - 友好错误消息
  - 日志记录

- [ ] **完善测试**
  - 补充单元测试
  - 集成测试
  - E2E测试 (可选)
  - 测试覆盖率 > 70%

#### Day 27: Docker化

- [ ] **Dockerfile**

  ```dockerfile
  FROM node:22-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN pnpm install --prod
  COPY dist ./dist
  EXPOSE 3000
  CMD ["node", "dist/index.js", "start"]
  ```

- [ ] **docker-compose.yml**

  ```yaml
  services:
    openclaw-mvp:
      build: .
      ports:
        - "3000:3000"
      volumes:
        - ./data:/app/data
      environment:
        - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
        - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
  ```

- [ ] **部署脚本**
  ```bash
  # scripts/deploy.sh
  docker compose build
  docker compose up -d
  ```

#### Day 28: 文档+发布

- [ ] **README.md**

  ```markdown
  # OpenClaw MVP

  ## Quick Start

  ## Configuration

  ## API Documentation

  ## Development

  ## Deployment
  ```

- [ ] **.env.example**

  ```bash
  ANTHROPIC_API_KEY=sk-ant-xxx
  TELEGRAM_BOT_TOKEN=123456:ABC-DEF
  API_TOKEN=your-secret-token
  DATABASE_PATH=./data/openclaw.db
  PORT=3000
  ```

- [ ] **API文档**
  - 端点列表
  - 请求/响应示例
  - 错误码说明

- [ ] **部署文档**
  - Docker部署步骤
  - VPS部署指南
  - 故障排查

### 📊 交付标准

✅ web_search工具可用
✅ Docker镜像可以构建和运行
✅ 完整的README和部署文档
✅ 测试覆盖率 > 70%
✅ 可以在干净环境下一键部署

---

## 📊 技术栈总览

### 核心依赖 (< 15个)

```json
{
  "dependencies": {
    "express": "^5.0.0", // HTTP服务器
    "ws": "^8.18.0", // WebSocket
    "better-sqlite3": "^11.0.0", // SQLite数据库
    "@anthropic-ai/sdk": "^0.30.0", // Claude API
    "grammy": "^1.27.0", // Telegram Bot
    "commander": "^12.0.0", // CLI框架
    "zod": "^3.23.0", // 数据验证
    "pino": "^9.0.0", // 日志
    "dotenv": "^16.4.0", // 环境变量
    "axios": "^1.7.0", // HTTP客户端
    "cors": "^2.8.5" // CORS中间件
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^22.0.0",
    "@types/express": "^5.0.0",
    "@types/ws": "^8.5.0",
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0",
    "eslint": "^9.0.0",
    "prettier": "^3.4.0"
  }
}
```

### 前端依赖

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^5.0.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

---

## 🎯 里程碑检查点

### Week 1 完成 ✅

- [ ] 数据库可以正常CRUD
- [ ] Claude API可以成功对话
- [ ] 单元测试通过 (覆盖率 > 60%)

### Week 2 完成 ✅

- [ ] Telegram Bot可以接收和发送消息
- [ ] HTTP API所有端点可用
- [ ] CLI命令可以执行
- [ ] 集成测试通过 (覆盖率 > 70%)

### Week 3 完成 ✅

- [ ] Web UI可以访问
- [ ] 可以通过Web界面对话
- [ ] 响应式设计在移动端正常

### Week 4 完成 ✅ (MVP发布)

- [ ] web_search工具可用
- [ ] Docker可以一键部署
- [ ] 文档完整 (README + API + 部署指南)
- [ ] 在干净环境测试通过

---

## 🚨 风险管理

### 高风险项

| 风险                   | 缓解措施      | 预留时间    |
| ---------------------- | ------------- | ----------- |
| **Claude API限流**     | 实现重试+缓存 | Day 25      |
| **Telegram连接不稳定** | 错误处理+日志 | Day 12      |
| **前端开发延期**       | 简化UI设计    | 可延后1-2天 |
| **Docker构建失败**     | 提前测试      | Day 26      |

### 时间缓冲

- 每周预留1天处理意外问题
- 可以延后的功能：
  - WebSocket实时推送
  - 深色模式
  - E2E测试
  - calculator工具

---

## 📈 成功指标

### 定量指标

- ✅ 代码量 < 10K LOC
- ✅ 依赖数 < 20个
- ✅ 测试覆盖率 > 70%
- ✅ API响应时间 < 3秒
- ✅ Docker镜像 < 500MB
- ✅ 开发周期 = 4周

### 定性指标

- ✅ 新人30分钟内可以部署
- ✅ 代码清晰易懂
- ✅ 文档完整准确
- ✅ 对话体验流畅

---

## 🔄 开发流程

### 每日流程

```
09:00 - 开始工作，review昨天进度
09:30 - 实现当天任务
12:00 - 午休
13:30 - 继续开发
16:00 - 写测试
17:00 - 代码review + 文档更新
18:00 - 提交代码，计划明天任务
```

### 每周流程

**周一**: Sprint计划，分解任务
**周三**: 中期检查，调整计划
**周五**: Sprint回顾，Demo演示

### Git工作流

```bash
# 功能分支
git checkout -b feature/telegram-adapter
# 开发...
git commit -m "feat: implement telegram adapter"
git push origin feature/telegram-adapter
# 合并到main
git checkout main
git merge feature/telegram-adapter
```

---

## 📚 参考资源

### 必读文档

- [Claude API Docs](https://docs.anthropic.com/)
- [Grammy Guide](https://grammy.dev/guide/)
- [Express Guide](https://expressjs.com/en/guide/routing.html)
- [Vitest Guide](https://vitest.dev/guide/)

### 工具与模板

- [Shadcn/ui Components](https://ui.shadcn.com/)
- [Zustand Examples](https://github.com/pmndrs/zustand)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)

---

## 🚀 快速开始

```bash
# 1. 创建项目
mkdir openclaw-mvp && cd openclaw-mvp

# 2. 初始化
pnpm init
pnpm add express ws better-sqlite3 @anthropic-ai/sdk grammy commander zod pino dotenv axios cors
pnpm add -D typescript @types/node @types/express vitest tsx eslint prettier

# 3. 创建目录
mkdir -p src/{api,channels,chat,cli,llm,storage,utils}

# 4. 配置TypeScript
pnpm tsc --init

# 5. 开始第一个文件
touch src/index.ts
echo 'console.log("Hello OpenClaw MVP!");' > src/index.ts

# 6. 运行
pnpm tsx src/index.ts
```

---

**开始时间**: 2026-03-05
**预计完成**: 2026-04-02
**版本**: MVP 0.1.0

🎯 **现在就开始 Phase 0！**
