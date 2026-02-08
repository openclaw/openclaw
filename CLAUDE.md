# OpenClaw - 架构全景文档

> **版本**: kook-openclaw 2026.2.5
> **扫描时间**: 2026-02-06 20:54:25
> **最后更新**: 2026-02-07

---

## 项目愿景

OpenClaw 是一个**个人 AI 助手**，运行在用户自己的设备上。

**核心设计理念**：

- **本地优先**：在用户设备上运行
- **隐私保护**：单用户助手，数据不离开用户控制
- **可扩展插件**：通过插件系统支持多种渠道

---

## 技术栈

- **运行时**: Node.js >=22.12.0
- **包管理**: pnpm 10.23.0
- **语言**: TypeScript 5.9.3 (ES2023)
- **构建**: tsdown, rolldown
- **测试**: vitest
- **UI**: Vite, Lit
- **CLI**: commander

---

## 模块索引

| 模块路径          | 职责描述    | 状态 |
| ----------------- | ----------- | ---- |
| `src/agents/`     | AI 代理系统 | 核心 |
| `src/gateway/`    | 网关服务    | 核心 |
| `src/plugins/`    | 插件系统    | 核心 |
| `src/channels/`   | 渠道管理    | 核心 |
| `src/config/`     | 配置管理    | 核心 |
| `src/cli/`        | CLI 系统    | 核心 |
| `src/commands/`   | 业务命令    | 核心 |
| `src/auto-reply/` | 自动回复    | 核心 |
| `src/daemon/`     | 守护进程    | 核心 |
| `src/tui/`        | TUI 系统    | 核心 |

---

## TypeScript 新人指南

### 基本类型

```typescript
let userName: string = "Alice";
let userAge: number = 25;
let isActive: boolean = true;
```

### 接口

```typescript
interface User {
  id: string;
  name: string;
}
```

### Zod 验证

```typescript
import { z } from "zod";

const ConfigSchema = z.object({
  token: z.string().optional(),
});
```

---

## 运行与开发

```bash
# 构建项目
pnpm build

# 运行网关
pnpm gateway:dev

# 运行测试
pnpm test

# 代码检查
pnpm lint
```

---

## 编码规范

| 类型   | 约定             | 示例              |
| ------ | ---------------- | ----------------- |
| 文件名 | kebab-case       | `agent-runner.ts` |
| 类型名 | PascalCase       | `AgentRunner`     |
| 常量   | UPPER_SNAKE_CASE | `MAX_TIMEOUT`     |
| 函数名 | camelCase        | `runAgent`        |

---

## 参考链接

- **官方网站**: https://openclaw.ai
- **GitHub**: https://github.com/openclaw/openclaw
