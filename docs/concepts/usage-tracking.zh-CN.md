---
summary: "使用跟踪界面和凭据要求"
read_when:
  - 您正在连接提供商使用/配额界面
  - 您需要解释使用跟踪行为或身份验证要求
title: "使用跟踪"
---

# 使用跟踪

## 它是什么

- 直接从提供商的使用端点获取使用/配额。
- 没有估计成本；只有提供商报告的窗口。
- 人类可读的状态输出被标准化为 `X% 剩余`，即使上游 API 报告消耗的配额、剩余配额或仅原始计数。
- 会话级别的 `/status` 和 `session_status` 可以在实时会话快照稀疏时回退到最新的 transcript 使用条目。该回退填充缺失的令牌/缓存计数器，可以恢复活动运行时模型标签，并在会话元数据缺失或较小时偏好较大的面向提示的总数。现有的非零实时值仍然优先。

## 它在哪里显示

- 聊天中的 `/status`：带有会话令牌 + 估计成本（仅限 API 密钥）的富表情状态卡。当可用时，提供商使用情况显示为标准化的 `X% 剩余` 窗口，用于**当前模型提供商**。
- 聊天中的 `/usage off|tokens|full`：每个响应的使用情况页脚（OAuth 仅显示令牌）。
- 聊天中的 `/usage cost`：从 OpenClaw 会话日志聚合的本地成本摘要。
- CLI：`openclaw status --usage` 打印完整的每个提供商细分。
- CLI：`openclaw channels list` 打印与提供商配置一起的相同使用情况快照（使用 `--no-usage` 跳过）。
- macOS 菜单栏：上下文下的“使用情况”部分（仅在可用时）。

## 提供商 + 凭据

- **Anthropic (Claude)**：身份验证配置文件中的 OAuth 令牌。
- **GitHub Copilot**：身份验证配置文件中的 OAuth 令牌。
- **Gemini CLI**：身份验证配置文件中的 OAuth 令牌。
  - JSON 使用情况回退到 `stats`；`stats.cached` 被标准化为 `cacheRead`。
- **OpenAI Codex**：身份验证配置文件中的 OAuth 令牌（当存在时使用 accountId）。
- **MiniMax**：API 密钥或 MiniMax OAuth 身份验证配置文件。OpenClaw 将 `minimax`、`minimax-cn` 和 `minimax-portal` 视为相同的 MiniMax 配额界面，优先使用存储的 MiniMax OAuth（如果存在），否则回退到 `MINIMAX_CODE_PLAN_KEY`、`MINIMAX_CODING_API_KEY` 或 `MINIMAX_API_KEY`。MiniMax 的原始 `usage_percent` / `usagePercent` 字段表示**剩余**配额，因此 OpenClaw 在显示前反转它们；当存在时，基于计数的字段优先。
  - 编码计划窗口标签来自提供商的小时/分钟字段（如果存在），然后回退到 `start_time` / `end_time` 跨度。
  - 如果编码计划端点返回 `model_remains`，OpenClaw 优先选择聊天模型条目，当明确的 `window_hours` / `window_minutes` 字段不存在时从时间戳派生窗口标签，并在计划标签中包含模型名称。
- **Xiaomi MiMo**：通过环境/配置/身份验证存储的 API 密钥（`XIAOMI_API_KEY`）。
- **z.ai**：通过环境/配置/身份验证存储的 API 密钥。

当无法解析可用的提供商使用身份验证时，使用情况会被隐藏。提供商可以提供插件特定的使用身份验证逻辑；否则 OpenClaw 回退到匹配来自身份验证配置文件、环境变量或配置的 OAuth/API 密钥凭据。
