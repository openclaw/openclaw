# OpenClaw MVP 技术实现细节

**补充文档**: [MVP-REDESIGN.md](./MVP-REDESIGN.md)
**日期**: 2026-03-05

---

## 目录

1. [代码示例](#代码示例)
2. [性能优化](#性能优化)
3. [安全考虑](#安全考虑)
4. [部署指南](#部署指南)
5. [监控与日志](#监控与日志)
6. [故障排查](#故障排查)
7. [扩展路径](#扩展路径)

---

## 🔧 代码示例

### 完整的Server入口

```typescript
// src/server.ts
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { initDatabase } from "./storage/database";
import { UserRepository } from "./storage/users";
import { SessionRepository } from "./storage/sessions";
import { MessageRepository } from "./storage/messages";
import { TelegramAdapter } from "./channels/telegram";
import { MessageHandler } from "./chat/handler";
import { SessionManager } from "./chat/session";
import { ContextBuilder } from "./chat/context";
import { LLMClient } from "./llm/client";
import { ToolExecutor } from "./llm/executor";
import { logger } from "./utils/logger";
import { config } from "./config";
import chatRouter from "./api/routes/chat";
import sessionsRouter from "./api/routes/sessions";
import healthRouter from "./api/routes/health";
import { authMiddleware } from "./api/middleware/auth";
import { errorMiddleware } from "./api/middleware/error";

export async function startServer(options: { port: number }) {
  // 1. Initialize database
  const db = initDatabase(config.databasePath);
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);

  logger.info("Database initialized", { path: config.databasePath });

  // 2. Initialize LLM client
  const llm = new LLMClient(config.anthropicApiKey);
  const tools = new ToolExecutor();

  // 3. Initialize chat components
  const sessionManager = new SessionManager(users, sessions);
  const contextBuilder = new ContextBuilder(messages);
  const messageHandler = new MessageHandler(sessionManager, contextBuilder, llm, tools, messages);

  // 4. Initialize channels
  const channels: ChannelAdapter[] = [];

  if (config.channels.telegram.enabled) {
    const telegram = new TelegramAdapter(config.channels.telegram.botToken);
    telegram.onMessage(async (msg) => {
      try {
        const response = await messageHandler.handle(msg);
        await telegram.sendMessage(msg.platformUserId, response);
      } catch (error) {
        logger.error("Failed to handle message", { error, msg });
        await telegram.sendMessage(
          msg.platformUserId,
          "Sorry, I encountered an error processing your message.",
        );
      }
    });

    await telegram.start();
    channels.push(telegram);
    logger.info("Telegram channel started");
  }

  // 5. Setup Express app
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.app.locals.chatHandler = messageHandler;
    req.app.locals.users = users;
    req.app.locals.sessions = sessions;
    req.app.locals.messages = messages;
    next();
  });

  // Routes
  app.use("/api/health", healthRouter);
  app.use("/api/chat", authMiddleware, chatRouter);
  app.use("/api/sessions", authMiddleware, sessionsRouter);

  // Error handling
  app.use(errorMiddleware);

  // 6. Setup HTTP + WebSocket server
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    logger.info("WebSocket client connected");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "auth") {
          if (message.token === config.apiToken) {
            ws.send(JSON.stringify({ type: "auth_ok" }));
          } else {
            ws.send(JSON.stringify({ type: "auth_failed" }));
            ws.close();
          }
        } else if (message.type === "subscribe") {
          // Subscribe to session updates
          // TODO: implement session subscription
        }
      } catch (error) {
        logger.error("WebSocket message error", { error });
      }
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
    });
  });

  // 7. Start server
  httpServer.listen(options.port, () => {
    logger.info("Server started", {
      port: options.port,
      channels: channels.map((c) => c.name),
    });
  });

  // 8. Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");

    for (const channel of channels) {
      await channel.stop();
    }

    httpServer.close(() => {
      db.close();
      logger.info("Server stopped");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { app, httpServer, channels };
}
```

### Session Manager实现

```typescript
// src/chat/session.ts
import { UserRepository, User } from "../storage/users";
import { SessionRepository, Session } from "../storage/sessions";

export class SessionManager {
  constructor(
    private users: UserRepository,
    private sessions: SessionRepository,
  ) {}

  async getOrCreate(
    channelId: string,
    platformUserId: string,
    userName?: string,
  ): Promise<Session> {
    // 1. Get or create user
    let user = this.users.findByPlatform(channelId, platformUserId);

    if (!user) {
      user = this.users.create({
        channelId,
        platformUserId,
        userName: userName || "Unknown",
      });
    }

    // 2. Get or create default session
    let session = this.sessions.findByUser(user.id);

    if (!session) {
      session = this.sessions.create({
        userId: user.id,
        contextSummary: null,
      });
    }

    return session;
  }

  async updateLastActive(sessionId: number) {
    this.sessions.updateLastActive(sessionId);
  }

  async listUserSessions(userId: number): Promise<Session[]> {
    return this.sessions.findAllByUser(userId);
  }
}
```

### Context Builder实现

```typescript
// src/chat/context.ts
import { MessageRepository, Message } from "../storage/messages";

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export class ContextBuilder {
  constructor(
    private messages: MessageRepository,
    private maxHistoryMessages = 10,
  ) {}

  async build(sessionId: number): Promise<ContextMessage[]> {
    const systemPrompt = this.getSystemPrompt();
    const history = await this.getHistory(sessionId);

    return [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];
  }

  private getSystemPrompt(): string {
    return `You are a helpful AI assistant. You have access to tools like web search and calculator.

Guidelines:
- Be concise and helpful
- Use tools when appropriate
- If you don't know something, say so
- Maintain context across the conversation

Current date: ${new Date().toISOString().split("T")[0]}`;
  }

  private async getHistory(sessionId: number): Promise<Message[]> {
    const messages = await this.messages.getRecent(sessionId, this.maxHistoryMessages);

    // Reverse to get chronological order (oldest first)
    return messages.reverse();
  }

  async summarizeOldContext(sessionId: number): Promise<string> {
    // Future enhancement: use LLM to summarize old messages
    // For now, just return a simple summary
    const messages = await this.messages.getRecent(sessionId, 100);
    return `[Previous conversation with ${messages.length} messages]`;
  }
}
```

### Tool Executor实现

```typescript
// src/llm/executor.ts
import axios from "axios";
import { logger } from "../utils/logger";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
}

export class ToolExecutor {
  async execute(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        let result: string;

        switch (call.name) {
          case "web_search":
            result = await this.webSearch(call.arguments.query);
            break;

          case "calculator":
            result = await this.calculator(call.arguments.expression);
            break;

          default:
            result = `Unknown tool: ${call.name}`;
        }

        results.push({
          id: call.id,
          name: call.name,
          result,
        });
      } catch (error) {
        logger.error("Tool execution error", { error, call });
        results.push({
          id: call.id,
          name: call.name,
          result: `Error: ${error.message}`,
        });
      }
    }

    return results;
  }

  private async webSearch(query: string): Promise<string> {
    // Use DuckDuckGo Instant Answer API (no API key needed)
    const response = await axios.get("https://api.duckduckgo.com/", {
      params: {
        q: query,
        format: "json",
        no_html: 1,
      },
      timeout: 5000,
    });

    const data = response.data;

    if (data.AbstractText) {
      return data.AbstractText;
    }

    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const topics = data.RelatedTopics.slice(0, 3)
        .map((t: any) => t.Text)
        .filter(Boolean);

      return topics.join("\n\n");
    }

    return "No results found.";
  }

  private async calculator(expression: string): Promise<string> {
    try {
      // Simple eval (SECURITY: sanitize in production!)
      const sanitized = expression.replace(/[^0-9+\-*/().]/g, "");

      if (sanitized !== expression) {
        return "Invalid expression. Only numbers and basic operators allowed.";
      }

      const result = eval(sanitized);
      return `${expression} = ${result}`;
    } catch (error) {
      return `Error evaluating expression: ${error.message}`;
    }
  }
}
```

---

## ⚡ 性能优化

### 1. 数据库优化

#### SQLite配置

```typescript
// src/storage/database.ts
import Database from "better-sqlite3";

export function initDatabase(path: string) {
  const db = new Database(path);

  // Performance optimizations
  db.pragma("journal_mode = WAL"); // Write-Ahead Logging for better concurrency
  db.pragma("synchronous = NORMAL"); // Balance safety and speed
  db.pragma("cache_size = -64000"); // 64MB cache
  db.pragma("temp_store = MEMORY"); // Use memory for temp tables
  db.pragma("mmap_size = 30000000000"); // Use memory-mapped I/O

  // ... schema creation

  return db;
}
```

#### 索引策略

```sql
-- Add indices for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session_time
  ON messages(session_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions(user_id, last_active_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_platform
  ON users(channel_id, platform_user_id);
```

#### Prepared Statements

```typescript
// src/storage/messages.ts
export class MessageRepository {
  private insertStmt: Statement;
  private selectRecentStmt: Statement;

  constructor(private db: Database.Database) {
    // Prepare statements once
    this.insertStmt = db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?)
    `);

    this.selectRecentStmt = db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
  }

  create(msg: Omit<Message, "id">) {
    return this.insertStmt.run(msg.sessionId, msg.role, msg.content, msg.timestamp.toISOString());
  }

  getRecent(sessionId: number, limit = 10): Message[] {
    return this.selectRecentStmt.all(sessionId, limit);
  }
}
```

### 2. LLM响应缓存

```typescript
// src/llm/cache.ts
import { createHash } from "crypto";

interface CacheEntry {
  response: string;
  timestamp: number;
  expiresAt: number;
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private readonly TTL = 3600 * 1000; // 1 hour

  private hash(messages: any[]): string {
    const content = JSON.stringify(messages);
    return createHash("sha256").update(content).digest("hex");
  }

  get(messages: any[]): string | null {
    const key = this.hash(messages);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.response;
  }

  set(messages: any[], response: string) {
    const key = this.hash(messages);
    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.TTL,
    });
  }

  clear() {
    this.cache.clear();
  }

  // Cleanup expired entries
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
```

### 3. Rate Limiting

```typescript
// src/api/middleware/ratelimit.ts
import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private readonly MAX_REQUESTS = 60; // per minute
  private readonly WINDOW = 60 * 1000; // 1 minute

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.ip || "unknown";
      const now = Date.now();

      let entry = this.limits.get(key);

      if (!entry || now > entry.resetAt) {
        entry = {
          count: 0,
          resetAt: now + this.WINDOW,
        };
        this.limits.set(key, entry);
      }

      entry.count++;

      if (entry.count > this.MAX_REQUESTS) {
        res.status(429).json({
          error: "Too many requests",
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        });
        return;
      }

      res.setHeader("X-RateLimit-Limit", this.MAX_REQUESTS);
      res.setHeader("X-RateLimit-Remaining", this.MAX_REQUESTS - entry.count);
      res.setHeader("X-RateLimit-Reset", entry.resetAt);

      next();
    };
  }
}
```

---

## 🔒 安全考虑

### 1. 输入验证

```typescript
// src/utils/validation.ts
import { z } from "zod";

export const SendMessageSchema = z.object({
  sessionId: z.number().int().positive(),
  text: z.string().min(1).max(10000),
});

export const ConfigUpdateSchema = z.object({
  llm: z
    .object({
      model: z.string().optional(),
      maxTokens: z.number().int().positive().max(200000).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
  chat: z
    .object({
      maxHistoryMessages: z.number().int().positive().max(100).optional(),
    })
    .optional(),
});

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}
```

### 2. SQL注入防护

```typescript
// ❌ BAD: String concatenation
const query = `SELECT * FROM users WHERE id = ${userId}`;

// ✅ GOOD: Prepared statements
const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
const user = stmt.get(userId);
```

### 3. XSS防护

```typescript
// src/utils/sanitize.ts
export function sanitizeMarkdown(text: string): string {
  // Remove potentially dangerous HTML tags
  return text
    .replace(/<script[^>]*>.*?<\/script>/gi, "")
    .replace(/<iframe[^>]*>.*?<\/iframe>/gi, "")
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, ""); // Remove event handlers
}
```

### 4. API Token管理

```typescript
// src/api/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  const expectedToken = process.env.API_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // Timing-safe comparison to prevent timing attacks
  const tokenHash = createHash("sha256").update(token).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();

  if (!timingSafeEqual(tokenHash, expectedHash)) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  next();
}
```

### 5. 工具执行沙箱

```typescript
// src/llm/executor.ts (enhanced)
export class ToolExecutor {
  private readonly ALLOWED_DOMAINS = [
    "duckduckgo.com",
    "wikipedia.org",
    // whitelist
  ];

  private async webSearch(query: string): Promise<string> {
    // Sanitize query
    const sanitized = query.replace(/[^\w\s]/g, "");

    if (sanitized.length < 2) {
      throw new Error("Query too short");
    }

    // Rate limit per session
    // TODO: implement rate limiting

    const response = await axios.get("https://api.duckduckgo.com/", {
      params: { q: sanitized, format: "json" },
      timeout: 5000,
      maxRedirects: 0, // Prevent redirect attacks
    });

    // Sanitize response
    return this.sanitizeToolOutput(response.data.AbstractText || "No results");
  }

  private sanitizeToolOutput(output: string): string {
    // Remove potential injection attempts
    return output
      .replace(/<script/gi, "&lt;script")
      .replace(/javascript:/gi, "")
      .slice(0, 2000); // Limit output length
  }
}
```

---

## 🚀 部署指南

### 1. 本地开发部署

```bash
# 1. Clone and install
git clone <repo-url>
cd openclaw-mvp
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Build
pnpm build

# 4. Run database migrations (if any)
pnpm migrate

# 5. Start server
pnpm start

# Or development mode with hot reload
pnpm dev
```

### 2. Docker部署

#### Dockerfile

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start
CMD ["node", "dist/index.js", "start", "--port", "3000"]
```

#### docker-compose.yml

```yaml
version: "3.9"

services:
  openclaw-mvp:
    build: .
    container_name: openclaw-mvp
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - API_TOKEN=${API_TOKEN}
      - DATABASE_PATH=/app/data/openclaw.db
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    networks:
      - openclaw

  # Optional: nginx reverse proxy
  nginx:
    image: nginx:alpine
    container_name: openclaw-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - openclaw-mvp
    networks:
      - openclaw

networks:
  openclaw:
    driver: bridge
```

### 3. VPS部署 (Ubuntu)

```bash
# 1. Update system
sudo apt update && sudo apt upgrade -y

# 2. Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# 3. Install Docker Compose
sudo apt install docker-compose-plugin -y

# 4. Clone repository
git clone <repo-url>
cd openclaw-mvp

# 5. Configure environment
cp .env.example .env
nano .env  # Edit credentials

# 6. Start services
docker compose up -d

# 7. View logs
docker compose logs -f

# 8. Setup systemd service (optional)
sudo nano /etc/systemd/system/openclaw.service
```

#### systemd服务文件

```ini
[Unit]
Description=OpenClaw MVP
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/user/openclaw-mvp
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
# Enable service
sudo systemctl enable openclaw
sudo systemctl start openclaw
```

### 4. 云平台部署

#### Fly.io

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh

# 2. Login
flyctl auth login

# 3. Launch app
flyctl launch

# 4. Set secrets
flyctl secrets set ANTHROPIC_API_KEY=<key>
flyctl secrets set TELEGRAM_BOT_TOKEN=<token>
flyctl secrets set API_TOKEN=<token>

# 5. Deploy
flyctl deploy

# 6. View logs
flyctl logs
```

#### Railway

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Initialize project
railway init

# 4. Set variables
railway variables set ANTHROPIC_API_KEY=<key>
railway variables set TELEGRAM_BOT_TOKEN=<token>

# 5. Deploy
railway up
```

---

## 📊 监控与日志

### 1. 结构化日志

```typescript
// src/utils/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
});
```

### 2. 请求日志中间件

```typescript
// src/api/middleware/logger.ts
import { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;

    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
  });

  next();
}
```

### 3. 性能监控

```typescript
// src/utils/metrics.ts
export class Metrics {
  private counters = new Map<string, number>();
  private timers = new Map<string, number[]>();

  increment(name: string, value = 1) {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }

  recordTime(name: string, duration: number) {
    const times = this.timers.get(name) || [];
    times.push(duration);
    this.timers.set(name, times);
  }

  getStats() {
    const stats: Record<string, any> = {
      counters: Object.fromEntries(this.counters),
      timers: {},
    };

    for (const [name, times] of this.timers.entries()) {
      const sorted = times.slice().sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);

      stats.timers[name] = {
        count: times.length,
        avg: sum / times.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: sorted[Math.floor(times.length * 0.5)],
        p95: sorted[Math.floor(times.length * 0.95)],
        p99: sorted[Math.floor(times.length * 0.99)],
      };
    }

    return stats;
  }

  reset() {
    this.counters.clear();
    this.timers.clear();
  }
}

export const metrics = new Metrics();
```

### 4. 健康检查端点

```typescript
// src/api/routes/health.ts
import { Router } from "express";
import { metrics } from "../../utils/metrics";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: process.env.npm_package_version,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

router.get("/metrics", (req, res) => {
  res.json(metrics.getStats());
});

export default router;
```

---

## 🔍 故障排查

### 常见问题

#### 1. Telegram Bot不响应

**症状**: Bot收到消息但不回复

**排查步骤**:

```bash
# 1. 检查Bot是否运行
curl http://localhost:3000/api/health

# 2. 查看日志
docker compose logs -f openclaw-mvp | grep telegram

# 3. 测试Telegram API连接
curl https://api.telegram.org/bot<TOKEN>/getMe

# 4. 检查webhook设置 (应该为空)
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

**解决方法**:

- 验证 `TELEGRAM_BOT_TOKEN` 正确
- 确保Bot有权限读取消息
- 检查网络连接

#### 2. Claude API错误

**症状**: 回复失败，错误码 429/500

**排查步骤**:

```bash
# 1. 验证API Key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hi"}]}'

# 2. 查看速率限制
# Check response headers for X-RateLimit-*

# 3. 检查日志
grep "LLM" logs/app.log
```

**解决方法**:

- 429: 降低请求频率，实现指数退避
- 500: 检查请求格式，重试
- 401: 验证API Key有效性

#### 3. 数据库锁定

**症状**: 写入失败，"database is locked"

**排查步骤**:

```bash
# 1. 检查数据库文件权限
ls -la data/openclaw.db*

# 2. 查看WAL模式
sqlite3 data/openclaw.db "PRAGMA journal_mode;"

# 3. 检查并发写入
lsof data/openclaw.db
```

**解决方法**:

```typescript
// 确保WAL模式已启用
db.pragma("journal_mode = WAL");

// 设置busy timeout
db.pragma("busy_timeout = 5000");

// 使用事务包装多个写入
db.transaction(() => {
  // multiple inserts
})();
```

#### 4. 内存泄漏

**症状**: 内存持续增长，最终OOM

**排查步骤**:

```bash
# 1. 监控内存使用
docker stats openclaw-mvp

# 2. 生成heap dump
node --inspect dist/index.js
# Chrome DevTools -> Memory -> Take snapshot

# 3. 检查事件监听器
# 是否有未清理的listeners
```

**解决方法**:

```typescript
// 1. 清理旧的cache entries
setInterval(() => {
  responseCache.cleanup();
}, 60 * 1000);

// 2. 限制cache大小
if (cache.size > MAX_CACHE_SIZE) {
  const oldest = cache.keys().next().value;
  cache.delete(oldest);
}

// 3. 移除事件监听器
ws.on("close", () => {
  ws.removeAllListeners();
});
```

---

## 🔄 扩展路径

### 从MVP到完整产品

#### Phase 1: MVP → MVP+ (Month 2-3)

**新增功能**:

1. **第二个消息渠道** (Discord)

   ```typescript
   // src/channels/discord.ts
   import { Client, GatewayIntentBits } from "discord.js";

   export class DiscordAdapter implements ChannelAdapter {
     // Similar to TelegramAdapter
   }
   ```

2. **OpenAI备用模型**

   ```typescript
   // src/llm/client.ts
   export class MultiModelClient {
     async chat(messages: ChatMessage[]): Promise<ChatResponse> {
       try {
         return await this.claudeClient.chat(messages);
       } catch (error) {
         logger.warn("Claude failed, falling back to GPT", { error });
         return await this.openaiClient.chat(messages);
       }
     }
   }
   ```

3. **Streaming响应**

   ```typescript
   async chatStream(messages: ChatMessage[]): AsyncIterable<string> {
     const stream = await this.client.messages.create({
       model: "claude-sonnet-4-6",
       messages,
       stream: true,
     });

     for await (const chunk of stream) {
       if (chunk.type === "content_block_delta") {
         yield chunk.delta.text;
       }
     }
   }
   ```

4. **基础权限控制**
   ```typescript
   // Allowlist per channel
   if (!config.channels.telegram.allowedUsers.includes(msg.platformUserId)) {
     return "Sorry, you are not authorized.";
   }
   ```

#### Phase 2: 插件系统 (Month 4-5)

**设计目标**: 简单、可扩展

```typescript
// src/plugins/types.ts
export interface Plugin {
  name: string;
  version: string;
  init(context: PluginContext): Promise<void>;
  onMessage?(msg: Message): Promise<Message | null>;
  tools?: ToolDefinition[];
  channels?: ChannelAdapter[];
}

export interface PluginContext {
  logger: Logger;
  db: Database;
  config: Config;
  registerTool(tool: ToolDefinition): void;
  registerChannel(channel: ChannelAdapter): void;
}
```

**示例插件**:

```typescript
// plugins/weather/index.ts
export default {
  name: "weather",
  version: "1.0.0",

  async init(context) {
    context.registerTool({
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        location: { type: "string" },
      },
      execute: async ({ location }) => {
        // Call weather API
        return `Weather in ${location}: Sunny, 22°C`;
      },
    });
  },
};
```

**加载器**:

```typescript
// src/plugins/loader.ts
export class PluginLoader {
  async loadFromDirectory(dir: string): Promise<Plugin[]> {
    const plugins: Plugin[] = [];

    for (const entry of fs.readdirSync(dir)) {
      const path = `${dir}/${entry}`;

      if (fs.statSync(path).isDirectory()) {
        try {
          const plugin = await import(`${path}/index.js`);
          plugins.push(plugin.default);
        } catch (error) {
          logger.error("Failed to load plugin", { path, error });
        }
      }
    }

    return plugins;
  }
}
```

#### Phase 3: 高级功能 (Month 6+)

1. **向量记忆**

   ```typescript
   // Use sqlite-vec or external service
   import { embed } from "@anthropic-ai/sdk";

   export class VectorMemory {
     async store(text: string, metadata: any) {
       const embedding = await embed(text);
       // Store in vector database
     }

     async search(query: string, limit = 5) {
       const queryEmbedding = await embed(query);
       // Similarity search
     }
   }
   ```

2. **多会话策略**

   ```typescript
   export enum SessionScope {
     SINGLE = "single", // All messages in one session
     PER_USER = "per-user", // One session per user
     PER_CHANNEL_USER = "per-channel-user", // Isolated by channel
     PER_CONVERSATION = "per-conversation", // New session per conversation
   }
   ```

3. **工具沙箱 (Docker)**

   ```typescript
   import { Docker } from "dockerode";

   export class SandboxedToolExecutor {
     async execute(code: string): Promise<string> {
       const container = await docker.createContainer({
         Image: "python:3.11-alpine",
         Cmd: ["python", "-c", code],
         NetworkMode: "none", // No network access
         Memory: 128 * 1024 * 1024, // 128MB
         CpuShares: 512,
       });

       await container.start();
       const output = await container.logs({ stdout: true, stderr: true });
       await container.remove();

       return output.toString();
     }
   }
   ```

4. **PWA (Progressive Web App)**
   ```json
   // web/public/manifest.json
   {
     "name": "OpenClaw MVP",
     "short_name": "OpenClaw",
     "start_url": "/",
     "display": "standalone",
     "background_color": "#ffffff",
     "theme_color": "#000000",
     "icons": [
       {
         "src": "/icon-192.png",
         "sizes": "192x192",
         "type": "image/png"
       },
       {
         "src": "/icon-512.png",
         "sizes": "512x512",
         "type": "image/png"
       }
     ]
   }
   ```

---

## 📚 参考资源

### 官方文档

- [Claude API](https://docs.anthropic.com/)
- [Grammy (Telegram)](https://grammy.dev/)
- [Discord.js](https://discord.js.org/)
- [Better SQLite3](https://github.com/WiseLibs/better-sqlite3)
- [Express.js](https://expressjs.com/)
- [Zod](https://zod.dev/)

### 工具与库

- [Vitest](https://vitest.dev/)
- [Pino Logger](https://getpino.io/)
- [Commander.js](https://github.com/tj/commander.js)
- [Docker](https://docs.docker.com/)

### 学习资源

- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [TypeScript Deep Dive](https://basarat.gitbook.io/typescript/)
- [SQLite Performance Tuning](https://www.sqlite.org/pragma.html)

---

**文档版本**: 1.0
**最后更新**: 2026-03-05
**License**: MIT
