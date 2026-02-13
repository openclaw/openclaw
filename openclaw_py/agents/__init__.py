"""Agent runtime system.

This module provides AI agent functionality including model selection,
provider implementations, message creation, tools, and skills.
"""

# Auth profiles
from .auth_profiles import (
    AUTH_PROFILE_FILENAME,
    AUTH_STORE_VERSION,
    ApiKeyCredential,
    AuthProfileCredential,
    AuthProfileFailureReason,
    AuthProfileStore,
    CLAUDE_CLI_PROFILE_ID,
    CODEX_CLI_PROFILE_ID,
    LEGACY_AUTH_FILENAME,
    OAuthCredential,
    ProfileUsageStats,
    TokenCredential,
    clear_auth_profile_cooldown,
    ensure_auth_profile_store,
    is_profile_in_cooldown,
    list_profiles_for_provider,
    load_auth_profile_store,
    mark_auth_profile_cooldown,
    mark_auth_profile_failure,
    mark_auth_profile_good,
    mark_auth_profile_used,
    resolve_auth_profile_order,
    save_auth_profile_store,
    set_auth_profile_order,
    update_auth_profile_store_with_lock,
    upsert_auth_profile,
)

# Tools and Skills
from .skills import (
    Skill,
    SkillEntry,
    SkillSnapshot,
    build_workspace_skill_snapshot,
    build_workspace_skills_prompt,
)
from .tools import (
    AnyAgentTool,
    ToolContext,
    ToolPolicy,
    ToolProfile,
    ToolResult,
    create_coding_tools,
    create_openclaw_tools,
    get_tool_context,
)

# Agent runtime
from .compaction import PruneHistoryResult, prune_history_for_context_share
from .context_window import (
    CONTEXT_WINDOW_HARD_MIN_TOKENS,
    CONTEXT_WINDOW_WARN_BELOW_TOKENS,
    ContextWindowGuardResult,
    ContextWindowInfo,
    evaluate_context_window_guard,
    resolve_context_window_info,
)
from .defaults import (
    DEFAULT_CONTEXT_TOKENS,
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_TEMPERATURE,
)
from .message_chunking import (
    BASE_CHUNK_RATIO,
    MIN_CHUNK_RATIO,
    SAFETY_MARGIN,
    chunk_messages_by_max_tokens,
    compute_adaptive_chunk_ratio,
    is_oversized_for_summary,
    split_messages_by_token_share,
)
from .model_catalog import (
    get_model_context_window,
    get_model_info,
    get_model_max_tokens,
    list_models,
    load_model_catalog,
)
from .model_selection import model_key, normalize_model_id, normalize_provider_id, parse_model_ref
from .providers import AnthropicProvider, BaseProvider, LiteLLMProvider, OpenAIProvider
from .runtime import create_agent_message, get_provider_from_config
from .token_estimation import estimate_messages_tokens, estimate_tokens
from .transcript_repair import (
    ToolCallInputRepairReport,
    ToolUseRepairReport,
    make_missing_tool_result,
    repair_tool_call_inputs,
    repair_tool_use_result_pairing,
)
from .types import (
    AgentMessage,
    AgentResponse,
    ModelInfo,
    ModelRef,
    ProviderConfig,
    StreamChunk,
    UsageInfo,
)
from .usage import derive_prompt_tokens, derive_session_total_tokens, has_nonzero_usage, merge_usage, normalize_usage

__all__ = [
    # Auth profiles
    "ApiKeyCredential",
    "TokenCredential",
    "OAuthCredential",
    "AuthProfileCredential",
    "AuthProfileFailureReason",
    "ProfileUsageStats",
    "AuthProfileStore",
    "AUTH_STORE_VERSION",
    "AUTH_PROFILE_FILENAME",
    "LEGACY_AUTH_FILENAME",
    "CLAUDE_CLI_PROFILE_ID",
    "CODEX_CLI_PROFILE_ID",
    "load_auth_profile_store",
    "ensure_auth_profile_store",
    "save_auth_profile_store",
    "update_auth_profile_store_with_lock",
    "upsert_auth_profile",
    "list_profiles_for_provider",
    "mark_auth_profile_good",
    "set_auth_profile_order",
    "resolve_auth_profile_order",
    "mark_auth_profile_used",
    "mark_auth_profile_failure",
    "mark_auth_profile_cooldown",
    "clear_auth_profile_cooldown",
    "is_profile_in_cooldown",
    # Tools
    "AnyAgentTool",
    "ToolContext",
    "ToolPolicy",
    "ToolProfile",
    "ToolResult",
    "create_coding_tools",
    "create_openclaw_tools",
    "get_tool_context",
    # Skills
    "Skill",
    "SkillEntry",
    "SkillSnapshot",
    "build_workspace_skill_snapshot",
    "build_workspace_skills_prompt",
    # Defaults
    "DEFAULT_PROVIDER",
    "DEFAULT_MODEL",
    "DEFAULT_CONTEXT_TOKENS",
    "DEFAULT_MAX_TOKENS",
    "DEFAULT_TEMPERATURE",
    # Types
    "ModelRef",
    "UsageInfo",
    "AgentMessage",
    "AgentResponse",
    "StreamChunk",
    "ModelInfo",
    "ProviderConfig",
    # Context window
    "CONTEXT_WINDOW_HARD_MIN_TOKENS",
    "CONTEXT_WINDOW_WARN_BELOW_TOKENS",
    "ContextWindowInfo",
    "ContextWindowGuardResult",
    "resolve_context_window_info",
    "evaluate_context_window_guard",
    # Token estimation
    "estimate_tokens",
    "estimate_messages_tokens",
    # Message chunking
    "BASE_CHUNK_RATIO",
    "MIN_CHUNK_RATIO",
    "SAFETY_MARGIN",
    "split_messages_by_token_share",
    "chunk_messages_by_max_tokens",
    "compute_adaptive_chunk_ratio",
    "is_oversized_for_summary",
    # Compaction
    "PruneHistoryResult",
    "prune_history_for_context_share",
    # Transcript repair
    "ToolUseRepairReport",
    "ToolCallInputRepairReport",
    "repair_tool_use_result_pairing",
    "repair_tool_call_inputs",
    "make_missing_tool_result",
    # Model catalog
    "load_model_catalog",
    "get_model_info",
    "list_models",
    "get_model_context_window",
    "get_model_max_tokens",
    # Model selection
    "parse_model_ref",
    "normalize_provider_id",
    "normalize_model_id",
    "model_key",
    # Usage
    "normalize_usage",
    "derive_prompt_tokens",
    "has_nonzero_usage",
    "derive_session_total_tokens",
    "merge_usage",
    # Providers
    "BaseProvider",
    "AnthropicProvider",
    "OpenAIProvider",
    "LiteLLMProvider",
    # Runtime
    "get_provider_from_config",
    "create_agent_message",
]
