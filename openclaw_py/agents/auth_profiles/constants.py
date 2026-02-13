"""Auth profile constants."""

AUTH_STORE_VERSION = 1
AUTH_PROFILE_FILENAME = "auth-profiles.json"
LEGACY_AUTH_FILENAME = "auth.json"

# Predefined profile IDs for external CLI tools
CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli"
CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli"
QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli"
MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli"

# File lock configuration (compatible with filelock library)
AUTH_STORE_LOCK_TIMEOUT = 30.0  # seconds
AUTH_STORE_LOCK_STALE = 30.0  # seconds

# External CLI sync TTL
EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000  # 15 minutes
EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000  # 10 minutes
