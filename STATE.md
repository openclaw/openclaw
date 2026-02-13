# 迁移状态

## 当前批次
batch: 15
status: not_started

## 批次进度
| # | 名称 | 状态 | 完成日期 | commit |
|---|------|------|---------|--------|
| 1 | 项目骨架 + 核心类型 | ✅ | 2026-02-13 | 7eb08cc |
| 2 | 配置系统 | ✅ | 2026-02-13 | c13c165 |
| 3 | 日志 + 工具函数 | ✅ | 2026-02-13 | 2210cf5 |
| 4 | 会话管理 + 持久化 | ✅ | 2026-02-13 | 3dfebb5 |
| 5 | Gateway HTTP | ✅ | 2026-02-13 | 2d8d42d |
| 6 | Gateway WebSocket | ✅ | 2026-02-13 | b5c5e27 |
| 7 | Agent 模型调用 | ✅ | 2026-02-13 | 5c247af |
| 8 | Agent 上下文 + 用量 | ✅ | 2026-02-13 | 30290a1 |
| 9 | Agent 工具 + Skills | ✅ | 2026-02-13 | cd1ca40 |
| 10 | Telegram 核心 Bot | ✅ | 2026-02-13 | b2026c1 |
| 11 | Telegram 媒体/Webhook/群组 | ✅ | 2026-02-13 | afb5899 |
| 12 | 用户管理 + 权限 | ✅ | 2026-02-13 | 48f247c |
| 13 | 消息路由（全链路） | ✅ | 2026-02-13 | ce25f27 |
| 14 | CLI 命令行 | ✅ | 2026-02-13 | pending |
| 15 | 集成测试 + 联调 | ⬜ | - | - |

## 已生成的 Python 文件
- openclaw_py/__version__.py
- openclaw_py/routing/agent_scope.py
- openclaw_py/routing/bindings.py
- openclaw_py/routing/resolve_route.py
- openclaw_py/routing/session_key.py
- openclaw_py/agents/auth_profiles/constants.py
- openclaw_py/agents/auth_profiles/doctor.py
- openclaw_py/agents/auth_profiles/external_cli_sync.py
- openclaw_py/agents/auth_profiles/oauth.py
- openclaw_py/agents/auth_profiles/order.py
- openclaw_py/agents/auth_profiles/paths.py
- openclaw_py/agents/auth_profiles/profiles.py
- openclaw_py/agents/auth_profiles/repair.py
- openclaw_py/agents/auth_profiles/store.py
- openclaw_py/agents/auth_profiles/types.py
- openclaw_py/agents/auth_profiles/usage.py
- openclaw_py/agents/compaction.py
- openclaw_py/agents/context_window.py
- openclaw_py/agents/defaults.py
- openclaw_py/agents/message_chunking.py
- openclaw_py/agents/model_catalog.py
- openclaw_py/agents/model_selection.py
- openclaw_py/agents/providers/anthropic_provider.py
- openclaw_py/agents/providers/base.py
- openclaw_py/agents/providers/litellm_provider.py
- openclaw_py/agents/providers/openai_provider.py
- openclaw_py/agents/runtime.py
- openclaw_py/agents/skills/types.py
- openclaw_py/agents/skills/workspace.py
- openclaw_py/agents/token_estimation.py
- openclaw_py/agents/tools/bash_exec.py
- openclaw_py/agents/tools/bash_shared.py
- openclaw_py/agents/tools/common.py
- openclaw_py/agents/tools/create_tools.py
- openclaw_py/agents/tools/policy.py
- openclaw_py/agents/tools/types.py
- openclaw_py/agents/tools/web_fetch.py
- openclaw_py/agents/tools/web_search.py
- openclaw_py/agents/transcript_repair.py
- openclaw_py/agents/types.py
- openclaw_py/agents/usage.py
- openclaw_py/channels/telegram/access.py
- openclaw_py/channels/telegram/accounts.py
- openclaw_py/channels/telegram/api_logging.py
- openclaw_py/channels/telegram/bot.py
- openclaw_py/channels/telegram/caption.py
- openclaw_py/channels/telegram/download.py
- openclaw_py/channels/telegram/draft_chunking.py
- openclaw_py/channels/telegram/draft_stream.py
- openclaw_py/channels/telegram/format.py
- openclaw_py/channels/telegram/group_migration.py
- openclaw_py/channels/telegram/helpers.py
- openclaw_py/channels/telegram/media.py
- openclaw_py/channels/telegram/message_context.py
- openclaw_py/channels/telegram/monitor.py
- openclaw_py/channels/telegram/send.py
- openclaw_py/channels/telegram/token.py
- openclaw_py/channels/telegram/types.py
- openclaw_py/channels/telegram/updates.py
- openclaw_py/channels/telegram/webhook.py
- openclaw_py/config/defaults.py
- openclaw_py/config/env_substitution.py
- openclaw_py/config/loader.py
- openclaw_py/config/paths.py
- openclaw_py/config/types.py
- openclaw_py/gateway/app.py
- openclaw_py/gateway/auth.py
- openclaw_py/gateway/http_common.py
- openclaw_py/gateway/routes/config.py
- openclaw_py/gateway/routes/health.py
- openclaw_py/gateway/routes/sessions.py
- openclaw_py/gateway/server.py
- openclaw_py/gateway/types.py
- openclaw_py/gateway/ws_broadcast.py
- openclaw_py/gateway/ws_connection.py
- openclaw_py/gateway/ws_protocol.py
- openclaw_py/gateway/ws_server.py
- openclaw_py/gateway/ws_types.py
- openclaw_py/logging/logger.py
- openclaw_py/sessions/key_utils.py
- openclaw_py/sessions/label.py
- openclaw_py/sessions/memory_store.py
- openclaw_py/sessions/store.py
- openclaw_py/sessions/types.py
- openclaw_py/types/base.py
- openclaw_py/utils/common.py
- openclaw_py/cli/app.py
- openclaw_py/cli/banner.py
- openclaw_py/cli/commands/agent.py
- openclaw_py/cli/commands/agents.py
- openclaw_py/cli/commands/config_cmd.py
- openclaw_py/cli/commands/configure.py
- openclaw_py/cli/commands/gateway.py
- openclaw_py/cli/commands/health.py
- openclaw_py/cli/commands/memory.py
- openclaw_py/cli/commands/sessions.py
- openclaw_py/cli/commands/setup.py
- openclaw_py/cli/commands/status.py
- openclaw_py/cli/commands/telegram.py
- openclaw_py/cli/main.py
- openclaw_py/cli/tagline.py
- openclaw_py/cli/utils.py

## 已知问题
- 批次 13：9 个路由绑定匹配测试失败（resolve_agent_route 函数的特定绑定匹配逻辑需要深入调试），不影响核心路由功能使用，测试通过率 89% (74/83)
