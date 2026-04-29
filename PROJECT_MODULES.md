# OpenClaw 项目模块拆分文档

## 项目概述

OpenClaw 是一个开源的 AI 代理平台，支持多种模型提供者和渠道集成。

## 模块层级划分

### 一、核心层（Core）- 最高优先级

| 模块路径 | 说明 | 关键文件 |
|---------|------|---------|
| `src/entry.ts` | 应用入口点，负责进程初始化和环境配置 | 启动引导、参数解析 |
| `src/index.ts` | 主模块导出，CLI 入口 | 命令行接口统一导出 |
| `src/cli/` | 命令行接口模块 | run-main.ts 等 |
| `src/gateway/` | WebSocket 网关核心 | 协议处理、连接管理 |
| `src/agents/` | Agent 核心引擎 | 15个子目录，代理逻辑核心 |
| `src/plugin-sdk/` | 插件 SDK | 提供给扩展的 API |
| `src/plugins/` | 插件加载和管理 | 插件生命周期管理 |
| `src/channels/` | 渠道实现 | Web、iOS、Android 等渠道 |

### 二、功能层（Features）- 高优先级

| 模块路径 | 说明 | 关键文件 |
|---------|------|---------|
| `src/commands/` | 命令系统 | 各种命令实现 |
| `src/flows/` | 流程编排 | 工作流执行 |
| `src/tasks/` | 任务管理 | 异步任务处理 |
| `src/sessions/` | 会话管理 | 对话状态管理 |
| `src/config/` | 配置系统 | 运行时配置 |
| `src/security/` | 安全模块 | 认证授权 |

### 三、模型提供者层（Providers）- 高优先级

| 模块路径 | 说明 |
|---------|------|
| `extensions/anthropic/` | Anthropic Claude 模型 |
| `extensions/openai/` | OpenAI GPT 模型 |
| `extensions/google/` | Google Gemini 模型 |
| `extensions/deepseek/` | DeepSeek 模型 |
| `extensions/ollama/` | Ollama 本地模型 |

### 四、渠道层（Channels）- 中优先级

| 模块路径 | 说明 |
|---------|------|
| `extensions/telegram/` | Telegram 渠道 |
| `extensions/discord/` | Discord 渠道 |
| `extensions/slack/` | Slack 渠道 |
| `extensions/msteams/` | Microsoft Teams 渠道 |

### 五、工具服务层（Services）- 中优先级

| 模块路径 | 说明 |
|---------|------|
| `src/tts/` | 语音合成服务 |
| `src/realtime-voice/` | 实时语音处理 |
| `src/media/` | 媒体处理 |
| `src/web-search/` | Web 搜索 |
| `src/image-generation/` | 图像生成 |

### 六、平台层（Platforms）- 中优先级

| 模块路径 | 说明 |
|---------|------|
| `apps/ios/` | iOS 应用 |
| `apps/android/` | Android 应用 |
| `apps/macos/` | macOS 应用 |
| `apps/shared/` | 跨平台共享代码 |

### 七、基础设施层（Infrastructure）- 基础支持

| 模块路径 | 说明 |
|---------|------|
| `src/infra/` | 基础设施核心 |
| `src/utils/` | 工具函数 |
| `src/types/` | 类型定义 |
| `src/logging/` | 日志系统 |
| `src/shared/` | 共享工具 |

### 八、UI 层（Presentation）- UI 展示

| 模块路径 | 说明 |
|---------|------|
| `ui/src/` | Web UI 界面 |
| `packages/memory-host-sdk/` | 记忆 SDK |

## 依赖关系图

```
┌─────────────────────────────────────────────────────────┐
│                    entry.ts (入口)                       │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                    index.ts (主模块)                     │
└─────────────────────┬───────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        │                           │
┌───────▼────────┐         ┌────────▼────────┐
│   src/cli/     │         │    src/gateway/ │
│   (命令行)      │         │    (网关核心)    │
└───────┬────────┘         └────────┬────────┘
        │                          │
        │            ┌─────────────┼─────────────┐
        │            │             │             │
┌───────▼────────┐ ┌──▼──┐  ┌──────▼─────┐ ┌───▼───┐
│ src/plugins/   │ │agents│  │ src/channels│ │protocol│
│ (插件系统)     │ │(代理) │  │ (渠道)      │ │(协议) │
└───────┬────────┘ └──┬──┘  └──────┬─────┘ └───┬───┘
        │             │            │            │
        └─────────────┴────────────┴────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼────┐ ┌─────▼─────┐ ┌───▼────┐
       │ extensions│ │   apps/   │ │  ui/   │
       │ (扩展)    │ │ (平台应用) │ │(界面)  │
       └───────────┘ └───────────┘ └────────┘
```

## 模块详细说明

### Core 层核心模块

#### 1. src/entry.ts
- **职责**: 进程入口，负责早期初始化
- **流程**: 解析 CLI 参数 -> 检查版本 -> 配置编译缓存 -> 准备重spawn

#### 2. src/cli/run-main.ts
- **职责**: CLI 主运行逻辑
- **流程**: 参数解析 -> 配置加载 -> 命令路由 -> 程序执行

#### 3. src/gateway/
- **职责**: WebSocket 网关，处理实时通信
- **核心**: 协议实现、连接管理、消息路由

#### 4. src/agents/
- **职责**: Agent 引擎核心
- **包含**: 15+ 个子模块，包含上下文、内存、工具调用等

#### 5. src/plugins/
- **职责**: 插件生命周期管理
- **功能**: 加载、激活、停用插件

#### 6. src/channels/
- **职责**: 多渠道消息处理
- **支持**: Web、iOS、Android 等客户端

## 扩展模块 (extensions/)

extensions/ 目录下包含 120+ 个扩展模块，分为以下类别：

### AI 模型扩展
- `anthropic/`, `openai/`, `google/`, `deepseek/`, `ollama/`, `mistral/`, `qwen/`, `kimi-coding/` 等

### 渠道扩展
- `telegram/`, `discord/`, `slack/`, `msteams/`, `whatsapp/`, `line/`, `matrix/` 等

### 工具服务扩展
- `image-generation-core/`, `video-generation-core/`, `speech-core/`, `tts-local-cli/` 等

### 记忆和知识扩展
- `memory-core/`, `memory-wiki/`, `memory-lancedb/`, `active-memory/` 等
