# OpenClaw Chat Commands

> A comprehensive guide to slash commands available in OpenClaw chat sessions.

Send these commands via WhatsApp, Telegram, Discord, or any connected channel to control your OpenClaw experience.

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Show current status |
| `/usage full` | Enable token/cost footer |
| `/model` | Show or change AI model |
| `/think high` | Enable extended thinking |
| `/reset` | Reset conversation |
| `/stop` | Stop current response |

---

## Commands by Category

### Session Management

Control your conversation sessions.

| Command | Aliases | Description | Usage |
|---------|---------|-------------|-------|
| `/reset` | | Reset the current session | `/reset` or `/reset keep-system` |
| `/new` | | Start a new session | `/new` or `/new <name>` |
| `/stop` | | Stop the current run | `/stop` |
| `/compact` | | Compact session context (reduce tokens) | `/compact` or `/compact <instructions>` |

**Examples:**
```
/reset              # Clear conversation history
/new project-x      # Start fresh session named "project-x"
/compact            # Summarize context to save tokens
/stop               # Interrupt a long-running response
```

---

### Options & Preferences

Customize how OpenClaw responds.

#### `/usage` - Token & Cost Tracking

Show token usage and costs per response.

| Mode | Description |
|------|-------------|
| `off` | No usage footer (default) |
| `tokens` | Show input/output token counts |
| `full` | Tokens + session key + estimated cost |
| `cost` | Cost summary only |

```
/usage full         # Enable detailed usage footer
/usage tokens       # Show just token counts
/usage off          # Disable usage footer
```

#### `/think` - Thinking Level

Control how much the AI "thinks" before responding. Higher levels = more thorough but slower.

| Level | Aliases | Description |
|-------|---------|-------------|
| `off` | | No extended thinking |
| `minimal` | | Light thinking |
| `low` | `/t low` | Basic reasoning |
| `medium` | `/t medium` | Moderate depth |
| `high` | `/t high` | Deep reasoning |
| `xhigh` | `/t xhigh` | Maximum thinking (slowest) |

```
/think high         # Enable deep thinking
/t medium           # Shorthand for medium thinking
/thinking off       # Disable extended thinking
```

#### `/verbose` - Verbose Mode

Show detailed tool calls and internal operations.

```
/verbose on         # Show tool calls, searches, etc.
/verbose off        # Hide internal details
/v on               # Shorthand
```

#### `/reasoning` - Reasoning Visibility

Control visibility of AI's reasoning process.

| Mode | Description |
|------|-------------|
| `on` | Show reasoning after response |
| `off` | Hide reasoning |
| `stream` | Stream reasoning in real-time |

```
/reasoning on       # Show reasoning summary
/reason stream      # Stream reasoning live
```

#### `/elevated` - Elevated Mode

Control permission level for potentially destructive operations.

| Mode | Description |
|------|-------------|
| `off` | Standard permissions |
| `on` | Elevated permissions enabled |
| `ask` | Ask before elevated operations |
| `full` | Full elevated access |

```
/elevated on        # Enable elevated mode
/elev ask           # Prompt before elevated ops
```

#### `/model` - AI Model Selection

Show or change the AI model.

```
/model                          # Show current model
/model anthropic/claude-sonnet  # Switch to Sonnet
/model openai/gpt-4o            # Switch to GPT-4o
/model google/gemini-2.0-flash  # Switch to Gemini
```

#### `/models` - List Available Models

List all available model providers and their models.

```
/models             # List all providers
/models anthropic   # List Anthropic models
/models openai      # List OpenAI models
```

#### `/queue` - Message Queue Settings

Control how multiple messages are handled.

| Mode | Description |
|------|-------------|
| `steer` | New messages steer current response |
| `interrupt` | New messages interrupt current response |
| `followup` | Queue messages for sequential processing |
| `collect` | Batch messages together |

```
/queue interrupt              # Interrupt mode
/queue followup debounce=2s   # Wait 2s between messages
/queue collect cap=5          # Collect up to 5 messages
```

#### `/exec` - Execution Defaults

Set defaults for shell command execution.

```
/exec host=local security=sandbox
/exec ask=on node=my-server
```

---

### Status & Information

Get information about your session and setup.

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | | Show available commands |
| `/commands` | | List all slash commands |
| `/status` | | Show current status (model, session, channels) |
| `/whoami` | `/id` | Show your sender ID |
| `/context` | | Explain how context is built |

```
/status             # See current config
/whoami             # See your ID (useful for allowlists)
/context            # Understand context window usage
```

---

### Management & Admin

Manage access, configuration, and subagents.

#### `/allowlist` - Access Control

Manage who can use the bot.

```
/allowlist                    # Show current allowlist
/allowlist add +15551234567   # Add phone number
/allowlist remove +15551234567
```

#### `/approve` - Execution Approvals

Approve or deny pending exec requests.

```
/approve            # Show pending requests
/approve yes        # Approve pending request
/approve no         # Deny pending request
```

#### `/config` - Configuration

View or modify configuration values.

| Action | Description |
|--------|-------------|
| `show` | Show all config |
| `get` | Get specific value |
| `set` | Set a value |
| `unset` | Remove a value |

```
/config show                              # Show all config
/config get agents.main.model             # Get specific setting
/config set agents.main.thinkLevel high   # Set a value
/config unset agents.main.thinkLevel      # Remove override
```

#### `/debug` - Runtime Debug Overrides

Set temporary debug values (resets on restart).

```
/debug show                   # Show current overrides
/debug set logging.level debug
/debug reset                  # Clear all overrides
```

#### `/subagents` - Subagent Management

Manage background agent runs.

| Action | Description |
|--------|-------------|
| `list` | List running subagents |
| `stop` | Stop a subagent |
| `log` | View subagent logs |
| `info` | Get subagent details |
| `send` | Send message to subagent |

```
/subagents list               # See running agents
/subagents stop 1             # Stop subagent #1
/subagents log 1 50           # Last 50 lines of log
/subagents send 1 stop task   # Send message to subagent
```

#### `/activation` - Group Activation Mode

Control how the bot responds in groups.

| Mode | Description |
|------|-------------|
| `mention` | Only respond when @mentioned |
| `always` | Respond to all messages |

```
/activation mention   # Require @mention in groups
/activation always    # Respond to everything
```

#### `/send` - Send Policy

Control outbound message permissions.

```
/send on              # Allow sending
/send off             # Block sending
/send inherit         # Use parent config
```

---

### Media & TTS

Control text-to-speech and media features.

#### `/tts` - Text-to-Speech

| Action | Description |
|--------|-------------|
| `on` | Enable TTS for responses |
| `off` | Disable TTS |
| `status` | Show current TTS settings |
| `provider` | Set voice provider |
| `limit` | Set max characters for TTS |
| `summary` | Toggle AI summary for long texts |
| `audio` | Generate TTS from custom text |

**Providers:** `edge`, `elevenlabs`, `openai`

```
/tts on                       # Enable TTS
/tts provider openai          # Use OpenAI voices
/tts limit 500                # Max 500 chars
/tts audio Hello world!       # Generate specific audio
```

---

### Tools & Skills

Run tools and skills directly.

| Command | Description |
|---------|-------------|
| `/bash` | Run shell commands (host-only) |
| `/skill` | Run a skill by name |
| `/restart` | Restart OpenClaw gateway |

```
/bash ls -la                  # Run shell command
/skill weather Dallas         # Run weather skill
/restart                      # Restart gateway
```

---

### Channel Docks

Switch reply channel (when multiple channels connected).

```
/dock-telegram        # Reply via Telegram
/dock-whatsapp        # Reply via WhatsApp
/dock-discord         # Reply via Discord
```

---

## Command Shortcuts

| Shortcut | Full Command |
|----------|--------------|
| `/t` | `/think` |
| `/v` | `/verbose` |
| `/id` | `/whoami` |
| `/elev` | `/elevated` |
| `/reason` | `/reasoning` |

---

## Tips

1. **See all commands:** Send `/commands` for a full list
2. **Get help on a command:** Most commands show help when called without arguments
3. **Cost tracking:** Use `/usage full` to monitor token usage and estimated costs
4. **Deep thinking:** Use `/think high` for complex problems requiring careful analysis
5. **Save context:** Use `/compact` when conversations get long
6. **Quick reset:** `/reset` clears history but keeps your settings

---

## Configuration Persistence

- **Session settings** (model, think level, etc.) persist for the current session
- **Config changes** via `/config set` persist across sessions
- **Debug overrides** reset when the gateway restarts

---

*For more details, see the [OpenClaw Documentation](https://docs.openclaw.ai)*
