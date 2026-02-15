// ============================================
// OPENCLAW SYSTEM PROTECTION PACK
// ============================================
//
// Protects OpenClaw system files from tampering.
// Disable this pack temporarily when you need to:
// - Bootstrap a new agent (edit SOUL.md, IDENTITY.md, USER.md)
// - Update workspace instructions (AGENTS.md, TOOLS.md)
// - Modify OpenClaw configuration
//
// All rule IDs prefixed with "openclaw-" for clear identification.
//
// Toggle via: openclaw config set plugins.entries.sondera.config.a3_openclawSystemPack false
// ============================================


// ============================================
// WORKSPACE INSTRUCTION FILES
// ============================================
// These files define agent identity, behavior, and instructions.
// Tampering could enable prompt injection attacks.

// Agent identity and personality files
@id("openclaw-block-workspace-identity")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/SOUL.md" ||
   context.params.path like "*/IDENTITY.md" ||
   context.params.path like "*/USER.md" ||
   context.params.path == "SOUL.md" ||
   context.params.path == "IDENTITY.md" ||
   context.params.path == "USER.md")
};

// Block shell-based writes to identity files (bypass prevention)
// Catches: echo > SOUL.md, cat > SOUL.md, tee SOUL.md, cp/mv to SOUL.md, sed -i
@id("openclaw-block-exec-identity")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*> SOUL.md*" ||
   context.params.command like "*>SOUL.md*" ||
   context.params.command like "*>> SOUL.md*" ||
   context.params.command like "*>>SOUL.md*" ||
   context.params.command like "*> IDENTITY.md*" ||
   context.params.command like "*>IDENTITY.md*" ||
   context.params.command like "*>> IDENTITY.md*" ||
   context.params.command like "*>>IDENTITY.md*" ||
   context.params.command like "*> USER.md*" ||
   context.params.command like "*>USER.md*" ||
   context.params.command like "*>> USER.md*" ||
   context.params.command like "*>>USER.md*" ||
   context.params.command like "*tee*SOUL.md*" ||
   context.params.command like "*tee*IDENTITY.md*" ||
   context.params.command like "*tee*USER.md*" ||
   context.params.command like "* cp *SOUL.md*" ||
   context.params.command like "* mv *SOUL.md*" ||
   context.params.command like "cp *SOUL.md*" ||
   context.params.command like "mv *SOUL.md*" ||
   context.params.command like "* cp *IDENTITY.md*" ||
   context.params.command like "* mv *IDENTITY.md*" ||
   context.params.command like "cp *IDENTITY.md*" ||
   context.params.command like "mv *IDENTITY.md*" ||
   context.params.command like "* cp *USER.md*" ||
   context.params.command like "* mv *USER.md*" ||
   context.params.command like "cp *USER.md*" ||
   context.params.command like "mv *USER.md*" ||
   context.params.command like "*sed -i*SOUL.md*" ||
   context.params.command like "*sed -i*IDENTITY.md*" ||
   context.params.command like "*sed -i*USER.md*")
};

// Agent instruction and tool configuration files
@id("openclaw-block-workspace-instructions")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/TOOLS.md" ||
   context.params.path like "*/AGENTS.md" ||
   context.params.path like "*/BOOTSTRAP.md" ||
   context.params.path like "*/BOOT.md" ||
   context.params.path like "*/HEARTBEAT.md" ||
   context.params.path == "TOOLS.md" ||
   context.params.path == "AGENTS.md" ||
   context.params.path == "BOOTSTRAP.md" ||
   context.params.path == "BOOT.md" ||
   context.params.path == "HEARTBEAT.md")
};

// Block shell-based writes to instruction files (bypass prevention)
@id("openclaw-block-exec-instructions")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*> TOOLS.md*" ||
   context.params.command like "*>TOOLS.md*" ||
   context.params.command like "*>> TOOLS.md*" ||
   context.params.command like "*> AGENTS.md*" ||
   context.params.command like "*>> AGENTS.md*" ||
   context.params.command like "*> BOOTSTRAP.md*" ||
   context.params.command like "*>> BOOTSTRAP.md*" ||
   context.params.command like "*> BOOT.md*" ||
   context.params.command like "*>> BOOT.md*" ||
   context.params.command like "*> HEARTBEAT.md*" ||
   context.params.command like "*>> HEARTBEAT.md*" ||
   context.params.command like "*tee*TOOLS.md*" ||
   context.params.command like "*tee*AGENTS.md*" ||
   context.params.command like "*tee*BOOTSTRAP.md*" ||
   context.params.command like "*tee*HEARTBEAT.md*" ||
   context.params.command like "*sed -i*TOOLS.md*" ||
   context.params.command like "*sed -i*AGENTS.md*" ||
   context.params.command like "*sed -i*BOOTSTRAP.md*" ||
   context.params.command like "*sed -i*HEARTBEAT.md*")
};


// ============================================
// SKILL INSTRUCTION FILES
// ============================================
// Skill instruction files define agent capabilities.
// Tampering could enable supply chain attacks.

// Block writing SKILL.md files (skill instruction tampering)
@id("openclaw-block-skill-instructions")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/SKILL.md" ||
   context.params.path == "SKILL.md")
};

// Block shell-based writes to SKILL.md (bypass prevention)
@id("openclaw-block-exec-skill")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*> SKILL.md*" ||
   context.params.command like "*>SKILL.md*" ||
   context.params.command like "*>> SKILL.md*" ||
   context.params.command like "*>>SKILL.md*" ||
   context.params.command like "*tee*SKILL.md*" ||
   context.params.command like "*sed -i*SKILL.md*" ||
   context.params.command like "cp *SKILL.md*" ||
   context.params.command like "mv *SKILL.md*" ||
   context.params.command like "* cp *SKILL.md*" ||
   context.params.command like "* mv *SKILL.md*")
};


// ============================================
// OPENCLAW CONFIGURATION
// ============================================
// Core configuration that controls OpenClaw behavior.

// Main config file - controls agents, channels, hooks, security settings
@id("openclaw-block-main-config")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/openclaw.json"
};


// ============================================
// CREDENTIALS AND AUTHENTICATION
// ============================================
// OAuth tokens, API keys, and authentication profiles.

// OAuth credentials directory
@id("openclaw-block-credentials")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/credentials/*"
};

// Per-agent authentication profiles
@id("openclaw-block-auth-profiles")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/agents/*/agent/auth-profiles.json"
};

// Block reading credentials too (prevent exfiltration)
@id("openclaw-block-read-credentials")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.openclaw/credentials/*" ||
   context.params.path like "*/.openclaw/agents/*/agent/auth-profiles.json")
};


// ============================================
// SESSION DATA
// ============================================
// Conversation history and memory databases.
// Tampering could enable context poisoning attacks.

// Session transcripts (conversation history)
@id("openclaw-block-session-transcripts")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/agents/*/sessions/*.jsonl"
};

// Session registry
@id("openclaw-block-session-registry")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/agents/*/sessions/sessions.json"
};

// Vector/memory databases
@id("openclaw-block-memory-databases")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.openclaw/agents/*/sessions/*.sqlite"
};


// ============================================
// PLUGIN SYSTEM
// ============================================
// Plugin manifests define capabilities and permissions.

// Plugin manifest files (excluding Sondera itself which is in base pack)
@id("openclaw-block-plugin-manifests")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/openclaw.plugin.json" ||
   context.params.path == "openclaw.plugin.json") &&
  !(context.params.path like "*/extensions/sondera/*")
};


// ============================================
// CLAUDE CODE SETTINGS
// ============================================
// Claude Code permissions and configuration.

@id("openclaw-block-claude-settings")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/.claude/settings.json" ||
   context.params.path like "*/.claude/settings.local.json")
};


// ============================================
// GIT HOOKS
// ============================================
// Git hooks can execute arbitrary code.

@id("openclaw-block-git-hooks")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.git/hooks/*"
};


// ============================================
// SECURITY TOOLING
// ============================================
// Files that control security scanning behavior.

@id("openclaw-block-security-config")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/.secrets.baseline" ||
   context.params.path like "*/.pre-commit-config.yaml" ||
   context.params.path like "*/.detect-secrets.cfg" ||
   context.params.path == ".secrets.baseline" ||
   context.params.path == ".pre-commit-config.yaml" ||
   context.params.path == ".detect-secrets.cfg")
};


// ============================================
// ANTHROPIC / CLAUDE CREDENTIALS
// ============================================
// Anthropic API keys and Claude Desktop data.

// Block reading Anthropic credentials directory
@id("openclaw-block-read-anthropic")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  context.params.path like "*/.anthropic/*"
};

// Block writing to Anthropic credentials directory
@id("openclaw-block-write-anthropic")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  context.params.path like "*/.anthropic/*"
};

// Block reading Claude Desktop data (conversation history, settings)
@id("openclaw-block-read-claude-desktop")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.local/share/io.anthropic.claude/*" ||
   context.params.path like "*/Library/Application Support/Claude/*")
};

// Block writing to Claude Desktop data
@id("openclaw-block-write-claude-desktop")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/.local/share/io.anthropic.claude/*" ||
   context.params.path like "*/Library/Application Support/Claude/*")
};


// ============================================
// HUGGINGFACE CREDENTIALS
// ============================================
// HuggingFace tokens and configuration.

// Block reading HuggingFace credentials
@id("openclaw-block-read-huggingface")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.huggingface/*" ||
   context.params.path like "*/.cache/huggingface/token")
};

// Block writing to HuggingFace credentials
@id("openclaw-block-write-huggingface")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/.huggingface/*" ||
   context.params.path like "*/.cache/huggingface/token")
};


// ============================================
// VS CODE EXTENSIONS
// ============================================
// VS Code extension directories - fake extensions can contain malware.

// Block writing to VS Code extensions directory
@id("openclaw-block-vscode-extensions")
forbid(principal, action, resource)
when {
  (action == Sondera::Action::"write" || action == Sondera::Action::"edit") &&
  context has params && context.params has path &&
  (context.params.path like "*/.vscode/extensions/*" ||
   context.params.path like "*/.vscode-server/extensions/*")
};
