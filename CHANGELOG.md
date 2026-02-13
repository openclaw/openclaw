# 迁移日志

> 每批次完成后由 /done 命令自动追加。

---

## 批次 1：项目骨架 + 核心类型（2026-02-13）

**新增文件**：
- openclaw_py/types/base.py - 核心基础类型定义
- openclaw_py/types/__init__.py - 类型模块导出
- openclaw_py/__init__.py - 包根模块
- tests/types/test_base.py - 核心类型单元测试

**核心变更**：
- 创建了 openclaw_py/ 项目目录结构（types, config, logging, utils, sessions, gateway, agents, channels, routing, users, cli）
- 定义了 14 个核心基础类型（ChatType, ReplyMode, TypingMode, SessionScope, DmScope, ReplyToMode, GroupPolicy, DmPolicy, MarkdownTableMode, SessionResetMode, SessionSendPolicyAction, SessionMaintenanceMode, LogLevel）
- 实现了 normalize_chat_type() 辅助函数（支持 "dm" -> "direct" 别名转换）
- 使用 typing.Literal 替代 TypeScript 的联合类型，保持类型安全
- 配置 Poetry 依赖管理（Python 3.13, Pydantic v2, aiogram 3.x, FastAPI, anthropic SDK, openai SDK, litellm）

**依赖的已有模块**：
- 无（批次 1 是基础，无依赖）

**已知问题**：
- 无

**测试结果**：22 passed

---
## 批次 2：配置系统（2026-02-13）

**新增文件**：
- openclaw_py/config/types.py - 配置 Pydantic 模型（OpenClawConfig, LoggingConfig, SessionConfig, TelegramConfig, ModelsConfig 等 40+ 模型）
- openclaw_py/config/env_substitution.py - 环境变量替换（支持 ${VAR} 语法和 $${} 转义）
- openclaw_py/config/paths.py - 配置文件和状态目录路径解析
- openclaw_py/config/defaults.py - 默认配置值应用
- openclaw_py/config/loader.py - 配置加载器（支持 YAML/JSON，自动环境变量替换和验证）
- openclaw_py/config/__init__.py - 配置模块导出
- tests/config/test_types.py - 配置类型验证测试（28 个测试）
- tests/config/test_env_substitution.py - 环境变量替换测试（16 个测试）
- tests/config/test_paths.py - 路径解析测试（16 个测试）
- tests/config/test_loader.py - 配置加载测试（20 个测试）

**核心变更**：
- 使用 Pydantic v2 定义完整的配置系统（40+ 配置模型）
- 实现环境变量替换功能（${VAR_NAME} 语法，支持转义和递归处理）
- 实现配置文件加载器（支持 YAML/JSON 格式）
- 支持配置路径自定义（OPENCLAW_CONFIG, OPENCLAW_STATE_DIR, OPENCLAW_HOME 环境变量）
- 实现配置快照功能（ConfigFileSnapshot，包含原始内容、解析结果、验证结果）
- 配置验证失败时提供详细错误信息（ConfigValidationError, MissingEnvVarError）
- 简化配置结构（仅保留 Telegram 频道，移除 Discord/Slack/Signal 等其他频道配置）
- 所有配置支持默认值自动应用

**依赖的已有模块**：
- openclaw_py.types.base - 核心枚举类型（ChatType, LogLevel, SessionScope, DmPolicy, GroupPolicy 等）

**已知问题**：
- 无

**测试结果**：80 passed（批次 2）+ 22 passed（批次 1）= 102 passed

---

## 批次 3：日志 + 工具函数（2026-02-13）

**新增文件**：
- openclaw_py/logging/logger.py - 基于 loguru 的日志系统（支持文件/控制台输出，自动轮转和压缩）
- openclaw_py/logging/__init__.py - 日志模块导出
- openclaw_py/utils/common.py - 通用工具函数（文件系统、数字、字符串、JSON、类型守卫）
- openclaw_py/utils/__init__.py - 工具模块导出
- tests/logging/test_logger.py - 日志系统测试（17 个测试）
- tests/utils/test_common.py - 工具函数测试（34 个测试）

**核心变更**：
- 使用 loguru 替代 TypeScript 的 tslog，实现日志系统
- 支持 7 种日志级别：silent, fatal, error, warn, info, debug, trace
- 支持 3 种控制台样式：pretty（彩色输出）, compact（紧凑格式）, json（JSON 格式）
- 自动日志轮转（10 MB）和压缩（保留 7 天，zip 格式）
- 默认日志路径：~/.openclaw/logs/openclaw.log
- 实现了 10 个通用工具函数：
  - 文件系统：ensure_dir, path_exists
  - 数字：clamp, clamp_int, clamp_number
  - 字符串：escape_regexp, normalize_path
  - JSON：safe_parse_json
  - 类型守卫：is_plain_object, is_record
- 简化了 TypeScript 版本的复杂功能（移除子系统日志、控制台捕获等）

**依赖的已有模块**：
- openclaw_py.config.types - LoggingConfig 配置模型

**已知问题**：
- 无

**测试结果**：153 passed（51 new + 102 from previous batches）

---

## 批次 4：会话管理 + 持久化（2026-02-13）

**新增文件**：
- openclaw_py/sessions/types.py - 会话数据模型（SessionEntry, SessionOrigin）
- openclaw_py/sessions/key_utils.py - 会话密钥解析工具
- openclaw_py/sessions/label.py - 会话标签验证
- openclaw_py/sessions/store.py - 会话持久化存储（JSON 文件，缓存，锁，轮转）
- openclaw_py/sessions/memory_store.py - 内存会话存储（ACP/subagent）
- openclaw_py/sessions/__init__.py - 会话模块导出
- tests/sessions/test_types.py - 会话类型测试（12 个测试）
- tests/sessions/test_key_utils.py - 密钥工具测试（29 个测试）
- tests/sessions/test_label.py - 标签验证测试（11 个测试）
- tests/sessions/test_memory_store.py - 内存存储测试（13 个测试）
- tests/sessions/test_store.py - 持久化存储测试（24 个测试）

**核心变更**：
- 实现了完整的会话管理系统
- JSON 文件持久化存储（~/.openclaw/sessions.json）
- 会话密钥系统（支持 agent:id:rest, subagent:, acp:, cron: 格式）
- 线程会话支持（:thread:, :topic: 分隔符）
- 会话存储缓存（TTL 45秒）
- 文件锁机制（防止并发写入冲突）
- 原子写入（临时文件 + rename，Windows/Unix 兼容）
- 自动会话维护：
  - 清理过期会话（默认 30 天）
  - 限制最大会话数（默认 500）
  - 文件轮转（默认 10MB，保留 3 个备份）
- 内存会话存储（用于 ACP/subagent，支持运行跟踪和取消）
- SessionEntry 简化版（核心字段，完整字段留待后续批次）

**依赖的已有模块**：
- openclaw_py.types - ChatType 等核心类型
- openclaw_py.config - SessionConfig 配置模型
- openclaw_py.logging - 日志系统
- openclaw_py.utils - 文件系统工具（ensure_dir, safe_parse_json）

**已知问题**：
- 无

**测试结果**：242 passed（89 new + 153 from previous batches）

**里程碑**：批次 4 是第一个里程碑 (v0.1-foundation)
- 完成了基础设施层：类型、配置、日志、工具、会话
- 为后续 Gateway 和 Agent 层提供了坚实基础

---
## 批次 5：Gateway HTTP Server（2026-02-13）

**新增文件**：
- openclaw_py/gateway/types.py - Gateway 数据模型（GatewayAuth, HealthCheckResponse, SessionListResponse, ConfigSnapshotResponse）
- openclaw_py/gateway/http_common.py - HTTP 响应工具函数（send_json, send_text, send_unauthorized 等）
- openclaw_py/gateway/auth.py - Gateway 认证逻辑（token/password/local-direct 三种认证方式）
- openclaw_py/gateway/routes/health.py - 健康检查端点（/health, /api/health）
- openclaw_py/gateway/routes/sessions.py - 会话管理 API（列出/获取/删除会话）
- openclaw_py/gateway/routes/config.py - 配置访问 API（获取配置/快照，自动脱敏）
- openclaw_py/gateway/app.py - FastAPI 应用工厂（CORS 配置，路由注册）
- openclaw_py/gateway/server.py - 服务器生命周期管理（GatewayServer, start_server, stop_server）
- openclaw_py/gateway/__init__.py - Gateway 模块导出
- openclaw_py/gateway/routes/__init__.py - 路由模块导出
- tests/gateway/test_types.py - Gateway 类型测试
- tests/gateway/test_http_common.py - HTTP 工具函数测试（9 个测试）
- tests/gateway/test_auth.py - 认证逻辑测试（13 个测试）
- tests/gateway/test_routes_health.py - 健康检查路由测试（3 个测试）
- tests/gateway/test_routes_sessions.py - 会话管理路由测试（11 个测试）
- tests/gateway/test_routes_config.py - 配置访问路由测试（6 个测试）
- tests/gateway/test_app.py - FastAPI 应用测试（7 个测试）
- tests/gateway/test_server.py - 服务器生命周期测试（11 个测试）

**核心变更**：
- 使用 FastAPI + uvicorn 实现 HTTP API 服务器
- 实现了 8 个 REST API 端点：
  - GET / - 根端点
  - GET /health - 简单健康检查
  - GET /api/health - 详细健康检查（含 uptime）
  - GET /api/sessions - 列出所有会话
  - GET /api/sessions/{session_key} - 获取单个会话
  - DELETE /api/sessions/{session_key} - 删除会话
  - GET /api/config - 获取配置（已脱敏）
  - GET /api/config/snapshot - 获取配置快照（含元数据）
- 实现了三种认证机制：
  - Local Direct: 127.0.0.1 直接访问（无需认证）
  - Bearer Token: Authorization 头部认证
  - Password: X-Password 头部认证
  - 优先级：local > token > password
- 实现了配置脱敏（移除 password, token, bot_token 等敏感字段）
- 配置了 CORS 中间件（支持跨域访问）
- 实现了优雅关闭（5 秒超时）
- 集成了批次 4 的会话存储系统
- 支持 Windows 路径和异步操作

**依赖的已有模块**：
- openclaw_py.config - OpenClawConfig, GatewayConfig 配置模型
- openclaw_py.sessions - load_session_store, save_session_store 会话持久化
- openclaw_py.logging - log_info, log_error 日志函数
- openclaw_py.types - ChatType 等核心类型

**已知问题**：
- 无

**测试结果**：302 passed（60 new + 242 from previous batches）

---

## 批次 6：Gateway WebSocket Server（2026-02-13）

**新增文件**：
- openclaw_py/gateway/ws_types.py - WebSocket 数据模型（ConnectParams, WebSocketClient, WebSocketFrame, WebSocketRequest, WebSocketResponse, WebSocketEvent, WebSocketError, ConnectionState）
- openclaw_py/gateway/ws_protocol.py - WebSocket 协议工具（parse_frame, create_response, create_error_response, create_event, validate_request, serialize_frame）
- openclaw_py/gateway/ws_broadcast.py - WebSocket 广播功能（broadcast_event, send_to_client, send_response_to_client）
- openclaw_py/gateway/ws_connection.py - WebSocket 连接管理（WebSocketConnectionManager, handle_websocket_connection, authenticate_connection）
- openclaw_py/gateway/ws_server.py - WebSocket 服务器集成（create_websocket_router, get_connection_manager, broadcast_to_all, /ws 端点, /ws-test 测试页面）
- openclaw_py/gateway/app.py - 更新（集成 WebSocket 路由）
- openclaw_py/gateway/__init__.py - 更新（导出 WebSocket 相关模块）
- tests/gateway/test_ws_types.py - WebSocket 类型测试（16 个测试）
- tests/gateway/test_ws_protocol.py - WebSocket 协议测试（19 个测试）
- tests/gateway/test_ws_broadcast.py - WebSocket 广播测试（10 个测试）
- tests/gateway/test_ws_connection.py - WebSocket 连接测试（13 个测试）
- tests/gateway/test_ws_server.py - WebSocket 服务器测试（9 个测试）
- tests/gateway/test_ws_integration.py - WebSocket 集成测试（7 个测试）

**核心变更**：
- 使用 FastAPI WebSocket 替代 Node.js ws 库实现 WebSocket 服务器
- 实现 JSON-RPC 风格消息协议：
  - Request 帧：客户端请求（type, id, method, params）
  - Response 帧：服务端响应（type, id, result, error）
  - Event 帧：服务端广播（type, event, params）
- 实现全局 WebSocketConnectionManager 单例：
  - connections 集合：跟踪所有活动连接
  - clients_by_id 索引：按客户端 ID 快速查找
  - 连接数统计、添加/移除连接
- 实现三种认证方式（与 HTTP 一致）：
  - Local Direct: 127.0.0.1, ::1 直接访问（无需认证）
  - TestClient: None IP 或 "testclient" IP（用于测试）
  - Token/Password: 远程认证（将来实现）
- 实现内置 WebSocket 方法：
  - connect: 建立连接（首帧必须为 connect）
  - ping: 心跳检测（返回 pong）
  - get_status: 获取连接状态
- 实现广播系统：
  - broadcast_event: 广播事件到所有连接
  - 自动移除失败/断开连接
  - 支持 drop_if_slow 参数（跳过慢客户端）
- 提供交互式测试页面 /ws-test：
  - 浏览器 WebSocket 客户端
  - 支持连接/断开/Ping/获取状态
  - 实时显示消息收发
- 连接生命周期管理：
  - 接受连接 -> 等待 connect 帧 -> 认证 -> 注册连接 -> 消息循环
  - 优雅处理 WebSocketDisconnect 异常
  - 自动清理断开的连接
- 保持与原 TypeScript 版本的协议兼容性（确保前端无需修改）

**依赖的已有模块**：
- openclaw_py.config.types - GatewayConfig 配置模型
- openclaw_py.logging - log_info, log_warn, log_error 日志函数
- openclaw_py.gateway.auth - get_client_ip, is_local_request 认证工具

**已知问题**：
- 无

**测试结果**：376 passed（74 new WebSocket + 60 HTTP + 242 from previous batches）

---

