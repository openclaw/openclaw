# OpenClaw TypeScript → Python 迁移

## 项目概述
OpenClaw 个人 AI 助手。后端从 TypeScript 转 Python，前端 UI 保留原 JS/TS。
只保留 Telegram 频道，其他频道删除。全功能保留。

## 当前进度
**批次 14 / 15：CLI 命令行** ✅ 已完成

## 已完成的 Python 文件
- openclaw_py/types/base.py - 核心基础类型（14 个 Literal 类型 + normalize_chat_type 函数）
- openclaw_py/config/*.py - 配置系统（types, env_substitution, paths, defaults, loader）
- openclaw_py/logging/logger.py - 日志系统（loguru，7 种日志级别）
- openclaw_py/utils/common.py - 通用工具函数（文件系统、数字、字符串、JSON、类型守卫）
- openclaw_py/sessions/*.py - 会话管理（types, key_utils, label, store, memory_store）
- openclaw_py/gateway/*.py - Gateway HTTP + WebSocket 服务器（types, http_common, auth, app, server, routes/*, ws_types, ws_protocol, ws_broadcast, ws_connection, ws_server）
- openclaw_py/agents/*.py - Agent 运行时（types, defaults, usage, model_selection, model_catalog, runtime, context_window, token_estimation, message_chunking, compaction, transcript_repair）
- openclaw_py/agents/providers/*.py - AI 提供商（base, anthropic_provider, openai_provider, litellm_provider）
- openclaw_py/agents/tools/*.py - Agent 工具系统（types, common, policy, bash_exec, bash_shared, web_fetch, web_search, create_tools）
- openclaw_py/agents/skills/*.py - Skills 系统（types, workspace）
- openclaw_py/agents/auth_profiles/*.py - Auth Profiles（types, constants, paths, store, profiles, order, usage, oauth, external_cli_sync, doctor, repair）
- openclaw_py/channels/telegram/*.py - Telegram Bot（types, helpers, token, accounts, access, api_logging, updates, message_context, bot, monitor, caption, format, download, media, draft_chunking, draft_stream, group_migration, send, webhook）
- openclaw_py/routing/*.py - 消息路由（session_key, agent_scope, bindings, resolve_route）
- openclaw_py/cli/*.py - CLI 命令行（banner, tagline, utils, app, main, commands/*）

## 环境
- Python 3.13（Conda 环境：marui）
- 包管理：Poetry
- IDE：PyCharm
- AI 工具：Claude Code (Max $200/月)

## 技术选型规则（必须遵守）
- 类型/校验：Pydantic v2
- Telegram：aiogram 3.x
- Web 服务器：FastAPI + uvicorn
- AI Claude：anthropic SDK
- AI OpenAI：openai SDK
- 多模型路由：litellm
- 异步：asyncio + aiofiles
- 日志：loguru
- CLI：typer
- 测试：pytest + pytest-asyncio
- JSON：orjson
- 事件：pyee
- 命名风格：snake_case

## 目录结构
```
openclaw_py/
├── types/          # Pydantic 数据模型
├── config/         # 配置加载和校验
├── logging/        # 日志系统
├── utils/          # 工具函数
├── sessions/       # 会话管理（持久化）
├── gateway/        # FastAPI 服务器（WebSocket + HTTP）
├── agents/         # AI Agent 运行时
│   ├── providers/  # Claude、OpenAI 等提供商
│   ├── tools/      # bash、文件操作等
│   └── skills/     # 自定义技能系统
├── channels/
│   └── telegram/   # Telegram 全功能
├── routing/        # 消息路由
├── users/          # 用户管理和权限
└── cli/            # 命令行工具
```

## 不要转换的目录
src/discord/、src/slack/、src/signal/、src/imessage/、
src/line/、src/web/ (WhatsApp)、src/macos/、src/canvas-host/、
src/browser/、src/tts/、src/daemon/、src/node-host/、src/tui/、
extensions/、Swabble/、apps/

## 前端 UI
保留原 JS/TS 不动。Python 后端必须保持 WebSocket 和 HTTP 协议
与原版兼容，确保前端无需修改即可连接。

## 转换原则
1. 先读懂 TS 逻辑，再用 Pythonic 方式重写
2. Gateway 协议必须兼容原版前端
3. 每个模块写 pytest 测试
4. 每批次完成后更新本文件
5. commit 格式：batch-N: 简短描述

## 批次列表
1.  ✅ 项目骨架 + 核心类型
2.  ✅ 配置系统
3.  ✅ 日志 + 工具函数
4.  ✅ 会话管理 + 持久化 🎯 v0.1-foundation
5.  ✅ Gateway 服务器 - HTTP
6.  ✅ Gateway 服务器 - WebSocket
7.  ✅ Agent 运行时 - 模型调用
8.  ✅ Agent 上下文 + 用量
9.  ✅ Agent 工具 + Skills 🎯 v0.2-engine
10. ✅ Telegram - 核心 Bot
11. ✅ Telegram - 媒体/Webhook/群组
12. ✅ Auth Profiles（AI 认证管理）
13. ✅ 消息路由（全链路） 🎯 v0.3-connected
14. ✅ CLI 命令行
15. ⬜ 集成测试 + 前后端联调 🎯 v1.0-python
