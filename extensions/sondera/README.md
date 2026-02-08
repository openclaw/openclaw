# Sondera Extension for OpenClaw

> ⚠️ **EXPERIMENTAL - DO NOT TRUST WITH REAL DATA** ⚠️

**Policy guardrails for OpenClaw agents.** Built by [Sondera](https://sondera.ai), powered by [Cedar](https://www.cedarpolicy.com/) (a policy language from AWS).

AI agents can delete files, leak credentials, or run dangerous commands. Prompting them to "be careful" isn't enough. Prompts are suggestions, not guarantees.

Sondera adds a **deterministic safety layer** that checks every tool call against security rules _before_ it executes. Unlike probabilistic safeguards, these rules always enforce.

**Why this matters:** As agents become more autonomous, the stakes get higher. You can't scale human oversight to every tool call. Deterministic guardrails give you governance without constant supervision. Predictable boundaries hold regardless of what the agent is asked to do, letting you run agents on longer missions with more autonomy and less babysitting.

> ⚠️ **Experimental:** This is a proof of concept demonstrating Cedar policy guardrails for OpenClaw. It is not officially supported and may silently fail to block dangerous actions. Do not use with real data. Use at your own risk.

## Requirements

**OpenClaw 2026.2.0 or later** with plugin hook support.

If the extension installs but doesn't block anything, your OpenClaw version may not have the required hooks yet. Check for updates or [join the OpenClaw Discord](https://discord.gg/clawd) for the latest compatibility info.

## Installation

### Pre-Release: Use Sondera Fork

The OpenClaw plugin hooks are not fully wired in the current release. We've submitted [PR #8448](https://github.com/openclaw/openclaw/pull/8448) to upstream these changes. Until it's merged, install from the Sondera fork:

```bash
# Clone the Sondera fork
git clone https://github.com/sondera-ai/openclaw.git
cd openclaw
git checkout sondera-pr

# Install and build
npm install -g pnpm
pnpm install
pnpm ui:build
pnpm build
pnpm openclaw onboard --install-daemon

# Start the gateway
pnpm openclaw gateway
# Dashboard: http://localhost:18789

# Dev container users (e.g. Trail of Bits devcontainer):
# Add to .devcontainer/devcontainer.json:
#   "forwardPorts": [18789],
#   "appPort": [18789]
# Then rebuild. Before pnpm install, run:
#   pnpm config set store-dir ~/.pnpm-store
# To start the gateway, use:
#   pnpm openclaw gateway --bind lan
```

We recommend testing in the [Trail of Bits devcontainer](https://github.com/trailofbits/claude-code-devcontainer) for sandboxed environments.

### Standard Installation (after hooks are merged)

```bash
openclaw plugins install @openclaw/sondera
```

The extension enables automatically with the 41-rule Base Pack.

### Verify It's Working

> **Tip:** After installing the extension, restart your OpenClaw gateway to load the new policies. Use the OpenClaw app menu or run `openclaw gateway restart`.

Try a blocked command to confirm Sondera is active:

```bash
# In an OpenClaw session, ask the agent to run:
sudo whoami
```

You should see: `Blocked by Sondera policy. (sondera-block-sudo)`

### Disable

```bash
# Disable the extension
openclaw plugins disable sondera

# Re-enable
openclaw plugins enable sondera
```

## What's Included

The extension ships with **103 rules** across three policy packs:

| Pack                | Rules | Default | Description                                                                                                  |
| ------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------ |
| **Sondera Base**    | 41    | Enabled | Blocks dangerous commands, protects credentials, redacts secrets                                             |
| **OpenClaw System** | 24    | Opt-in  | Protects workspace files (SOUL.md, etc.), sessions, config                                                   |
| **OWASP Agentic**   | 38    | Opt-in  | Based on [OWASP Top 10 for Agentic AI](https://genai.owasp.org). Supply chain, persistence, memory poisoning |

### Enable Additional Packs

Toggle packs in the **OpenClaw Settings UI**, or via CLI:

```bash
# Protect OpenClaw workspace files
openclaw config set plugins.entries.sondera.config.a2_openclawSystemPack true

# Add OWASP Agentic rules (more restrictive)
openclaw config set plugins.entries.sondera.config.a3_owaspAgenticPack true
```

## How It Works

Sondera hooks into OpenClaw at two stages:

**PRE_TOOL:** Before a tool executes, Sondera checks if the action is allowed:

```
Agent calls: rm -rf /tmp/cache
Sondera: DENY (sondera-block-rm)
Agent sees: "Blocked by Sondera policy. (sondera-block-rm)"
```

**What happens when blocked?** The agent sees the block message and stops that action. It won't automatically retry or find a workaround. You'll see exactly what was prevented and can decide how to proceed. This is intentional: guardrails stop dangerous actions, they don't make decisions for you.

**POST_TOOL:** After a tool executes, Sondera can redact sensitive output from session transcripts:

```
Tool returns: GITHUB_TOKEN=ghp_xxxxxxxxxxxx
Sondera: REDACT (sondera-redact-github-tokens)
Transcript shows: [REDACTED BY SONDERA POLICY]
```

> ⚠️ **Limitation:** POST_TOOL redaction only cleans what gets saved to transcripts. The agent and user still see secrets on screen during the session. This is a limitation of the current OpenClaw hook architecture. PRE_TOOL blocking (preventing the read in the first place) is the stronger protection.

## What Gets Blocked

### Dangerous Commands

- `rm`, `rm -rf`, `rm -fr`: File deletion
- `sudo`, `su`: Privilege escalation
- `curl | bash`, `wget | sh`: Remote code execution
- `nc -e`, `netcat`: Reverse shells
- `chmod 777`, `mkfs`, `dd`: System damage

### Credential Access

- `.ssh/id_*`: SSH private keys
- `.env`, `.env.*`: Environment files
- `.aws/`, `.gcloud/`: Cloud credentials
- `.npmrc`, `.pypirc`: Package manager tokens
- Shell history files

### Data Exfiltration

- `curl --data @file`: Upload via curl
- External POST requests
- Pastebin URLs

### Output Redaction

API keys, tokens, and secrets are redacted from session transcripts:

- GitHub tokens (`ghp_*`, `gho_*`)
- AWS credentials (`AKIA*`)
- Anthropic keys (`sk-ant-*`)
- OpenAI keys (`sk-proj-*`)
- Database connection strings
- Private keys (PEM format)

## Configuration

Configure Sondera via the **OpenClaw Settings UI** or the command line.

**Via UI:** Open the OpenClaw app and go to Settings > Extensions > Sondera. Toggle policy packs, enable lockdown mode, or add custom rules in the textarea.

**Via CLI:**

| Option                  | Default | Description                                 |
| ----------------------- | ------- | ------------------------------------------- |
| `a_policyPack`          | `true`  | Sondera Base Pack (41 rules)                |
| `a2_openclawSystemPack` | `false` | OpenClaw System Pack (24 rules)             |
| `a3_owaspAgenticPack`   | `false` | OWASP Agentic Pack (38 rules)               |
| `b_lockdown`            | `false` | Block ALL tools unless explicitly permitted |
| `c_customRules`         | `""`    | Your own Cedar rules (use UI for multiline) |
| `d_policyPath`          | `""`    | Use only this policy file (expert mode)     |

### Lockdown Mode

Block everything by default, then permit only what you need. This is the most secure pattern for high-risk environments.

**Step 1: Enable lockdown mode**

```bash
openclaw config set plugins.entries.sondera.config.b_lockdown true
```

**Step 2: Add permit rules for allowed actions**

With lockdown enabled, all tools are blocked unless you explicitly permit them. Add permit rules via the Settings UI or `c_customRules`:

```cedar
// Allow reading any file (but not writing)
@id("permit-read-all")
permit(principal, action, resource)
when {
  action == Sondera::Action::"read"
};

// Allow only git and npm commands
@id("permit-git-npm")
permit(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "git *" ||
   context.params.command like "npm *")
};

// Allow writing only to src/ directory
@id("permit-write-src")
permit(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  context.params.path like "*/src/*"
};
```

> **Tip:** If lockdown mode is too restrictive, start with the default policy pack and add `forbid` rules for specific things you want to block.

## Writing Custom Rules

Add custom Cedar rules via the **Custom Rules** textarea in Settings, or via CLI for simple rules.

Rules use two keywords:

- `forbid(...)` blocks actions that match
- `permit(...)` allows actions that match (useful with Lockdown Mode)

**Important:** If both `forbid` and `permit` match the same action, `forbid` wins. Deny always takes precedence.

Every rule has the same structure. You customize the `when` clause to match specific actions.

**Example: Block a specific command**

```cedar
@id("block-docker-run")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*docker run*"
};
```

**Example: Block reading a specific directory**

```cedar
@id("block-read-secrets")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  context.params.path like "*/my-secrets/*"
};
```

**Example: Allow only specific commands (with Lockdown Mode)**

```cedar
@id("allow-git-commands")
permit(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "git *"
};
```

### Available Actions

| Action                     | Triggered By        |
| -------------------------- | ------------------- |
| `Sondera::Action::"exec"`  | Bash/shell commands |
| `Sondera::Action::"read"`  | File reads          |
| `Sondera::Action::"write"` | File writes         |
| `Sondera::Action::"edit"`  | File edits          |
| `Sondera::Action::"glob"`  | File pattern search |
| `Sondera::Action::"grep"`  | Content search      |

### Context Variables

- `context.params.command`: The shell command (for exec)
- `context.params.path`: The file path (for read/write/edit)
- `context.params.pattern`: The glob pattern (for glob)
- `context.params.url`: The URL (for web fetch)

For more examples and advanced patterns, see the [Writing Policies Guide](https://docs.sondera.ai/writing-policies/).

## Policy Packs Reference

<details>
<summary><strong>Sondera Base Pack (41 rules)</strong></summary>

**Dangerous Commands:** `sondera-block-rm`, `sondera-block-rf-flags`, `sondera-block-sudo`, `sondera-block-su`, `sondera-block-chmod-777`, `sondera-block-disk-operations`, `sondera-block-kill-system`, `sondera-block-shutdown`

**Remote Code Execution:** `sondera-block-curl-shell`, `sondera-block-base64-shell`, `sondera-block-netcat`, `sondera-block-curl-upload`

**Sensitive Files:** `sondera-block-read-ssh-keys`, `sondera-block-read-credentials`, `sondera-block-read-cloud-creds`, `sondera-block-read-docker-creds`, `sondera-block-read-package-tokens`, `sondera-block-read-shell-history`, `sondera-block-write-ssh`, `sondera-block-write-env`, `sondera-block-write-git-internals`, `sondera-block-write-system-dirs`, `sondera-block-edit-sensitive`, `sondera-block-glob-sensitive`

**Network:** `sondera-block-paste-sites`, `sondera-block-curl-post-external`

**Output Redaction:** `sondera-redact-api-keys`, `sondera-redact-secrets`, `sondera-redact-aws-creds`, `sondera-redact-github-tokens`, `sondera-redact-slack-tokens`, `sondera-redact-db-conn-strings`, `sondera-redact-private-keys`, `sondera-redact-anthropic-keys`, `sondera-redact-openai-keys`, `sondera-redact-stripe-keys`, `sondera-redact-google-keys`, `sondera-redact-sendgrid-keys`, `sondera-redact-twilio-keys`, `sondera-redact-huggingface-tokens`

**Integrity:** `sondera-block-self-modify`

</details>

<details>
<summary><strong>OpenClaw System Pack (24 rules)</strong></summary>

**Workspace:** `openclaw-block-workspace-identity`, `openclaw-block-exec-identity`, `openclaw-block-workspace-instructions`, `openclaw-block-exec-instructions`, `openclaw-block-skill-instructions`, `openclaw-block-exec-skill`

**Config & Credentials:** `openclaw-block-main-config`, `openclaw-block-credentials`, `openclaw-block-auth-profiles`, `openclaw-block-read-credentials`

**Sessions:** `openclaw-block-session-transcripts`, `openclaw-block-session-registry`, `openclaw-block-memory-databases`

**Anthropic/Claude:** `openclaw-block-read-anthropic`, `openclaw-block-write-anthropic`, `openclaw-block-read-claude-desktop`, `openclaw-block-write-claude-desktop`, `openclaw-block-read-huggingface`, `openclaw-block-write-huggingface`

**Security:** `openclaw-block-plugin-manifests`, `openclaw-block-claude-settings`, `openclaw-block-git-hooks`, `openclaw-block-security-config`, `openclaw-block-vscode-extensions`

</details>

<details>
<summary><strong>OWASP Agentic Pack (38 rules)</strong></summary>

**ASI01 - Agent Goal Hijack:** `owasp-block-shell-eval`

**ASI02 - Tool Misuse:** `owasp-block-dns-exfil`, `owasp-block-socat`, `owasp-block-external-copy`, `owasp-block-tar-exfil`, `owasp-block-db-dump`

**ASI03 - Identity & Privilege Abuse:** `owasp-block-user-management`, `owasp-block-read-passwd`, `owasp-block-browser-creds`, `owasp-block-gpg-keys`, `owasp-block-setuid`

**ASI04 - Supply Chain Attacks:** `owasp-block-pip-url`, `owasp-block-npm-git`, `owasp-block-untrusted-repos`, `owasp-block-package-config-write`, `owasp-block-download-exec`

**ASI05 - Unexpected Code Execution:** `owasp-block-python-exec`, `owasp-block-node-exec`, `owasp-block-ruby-exec`, `owasp-block-perl-exec`, `owasp-block-unsafe-deserialize`, `owasp-block-crontab`, `owasp-block-cron-write`, `owasp-block-systemd`, `owasp-block-systemd-write`, `owasp-block-launchd`

**ASI06 - Memory & Context Poisoning:** `owasp-block-agent-memory`, `owasp-block-agent-config-write`, `owasp-block-agent-edit`, `owasp-block-vector-db`, `owasp-block-vector-db-write`, `owasp-redact-oauth-tokens`, `owasp-redact-jwt`

**ASI07 - Inter-Agent Communication:** `owasp-block-mcp-config`, `owasp-block-mcp-write`, `owasp-block-agent-cards`

**ASI10 - Rogue Agent Prevention:** `owasp-block-agent-spawn`, `owasp-block-fork-bomb`

</details>

## Learn More

- [OpenClaw Integration Guide](https://docs.sondera.ai/integrations/openclaw/): Step-by-step setup and configuration
- [Sondera Documentation](https://docs.sondera.ai): Full docs and guides
- [Cedar Policy Language](https://www.cedarpolicy.com/): Policy syntax reference
- [OWASP Agentic Top 10](https://genai.owasp.org): Security framework for the OWASP pack

**Want guardrails for other agents?** Sondera works with LangGraph, Google ADK, Strands, and custom agents. See [sondera.ai](https://sondera.ai) or the [Python SDK](https://github.com/sondera-ai/sondera-harness-python).

## Community

- [OpenClaw Discord](https://discord.gg/clawd): Questions and support
- [OpenClaw GitHub Issues](https://github.com/openclaw/openclaw/issues): Bug reports and feature requests

## License

MIT
