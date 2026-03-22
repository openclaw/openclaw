# Troubleshooting Guide

This guide covers common issues and their solutions when working with OpenClaw.

## Allowlist Configuration Issues

### Problem: Messages from unknown users are not being processed

**Symptoms:**
- DMs from new users are ignored
- Pairing code never arrives
- `openclaw doctor` shows DM policy warnings

**Solutions:**

1. **Check DM policy setting** in your channel configuration:
   ```bash
   # For Discord
   channels.discord.dmPolicy="pairing"  # or "open" for unrestricted
   
   # For Slack
   channels.slack.dmPolicy="pairing"
   ```

2. **Add wildcard to allowlist** if using `dmPolicy="open"`:
   ```bash
   channels.discord.allowFrom=["*"]  # Accept all DMs
   ```

3. **Approve pairing codes** when using `pairing` policy:
   ```bash
   openclaw pairing approve discord <code>
   ```

4. **Run diagnostics**:
   ```bash
   openclaw doctor
   ```
   This will highlight misconfigured DM policies and missing allowlist entries.

## sessions_send vs spawn Distinction

### Problem: Confusion about when to use `sessions_send` vs `sessions_spawn`

**`sessions_send` (message routing):**
- Use to send a message to an **existing** session
- Targets a specific session by key or label
- Session must already exist (created by user interaction or previous spawn)
- Example: Following up on a user conversation

**`sessions_spawn` (agent creation):**
- Use to create a **new** isolated session/agent
- Starts fresh context (unless resuming)
- Can specify runtime: `"subagent"` or `"acp"`
- Example: Starting a new coding task or research query

**Quick Reference:**
- Need to continue an existing conversation? → `sessions_send`
- Need a fresh agent for a new task? → `sessions_spawn`
- Delegating to another specialist? → `sessions_spawn` (then they may hand off back with `sessions_send`)

## Binding Specialists

### Problem: How to route specific tasks to the right agent

OpenClaw supports multi-agent routing through the Gateway. To bind specialists:

1. **Define agent labels** in configuration:
   ```bash
   agents.coding.id="coder"
   agents.researcher.id="researcher"
   agents.homey.id="homey"
   ```

2. **Route by session label** when spawning:
   ```bash
   sessions_spawn --label "coder" --task "Fix bug in main.py"
   ```

3. **Use coordinator for handoffs**:
   - Tell the coordinator: "I need homey to provide entity IDs"
   - Coordinator routes to the correct agent based on domain

4. **Session labels persist** across handoffs, preserving context.

**Common bindings:**
- `coder` → code tasks, GitHub operations
- `researcher` → API docs, specs, deep analysis
- `homey` → Home Assistant device state
- `flowbot` → n8n workflows
- `news` → RSS/monitoring feeds
- `oracle` → knowledge base, past errors

## Model Selection

### Problem: Using the wrong model or encountering model-related errors

**Symptoms:**
- Poor quality responses
- Rate limit errors
- Authentication failures
- Model not found

**Solutions:**

1. **Check current model configuration**:
   ```bash
   openclaw models list
   ```

2. **Override per-session** if needed:
   ```bash
   openclaw agent --message "task" --model openrouter/anthropic/claude-3.5-sonnet
   ```

3. **Verify provider credentials**:
   - Ensure API keys are set in environment or config
   - Check token scopes (read:repo for GitHub, etc.)

4. **Handle rate limits**:
   - Use `--thinking high` for complex tasks (allows more reasoning time)
   - Implement retry with backoff if using custom scripts

5. **Recommended models by task**:
   - Coding: `openrouter/anthropic/claude-3.5-sonnet` or `openrouter/openai/gpt-4o`
   - Research: `openrouter/anthropic/claude-3.5-sonnet` (high context)
   - Quick responses: `openrouter/google/gemini-flash-1.5`

6. **Test connectivity**:
   ```bash
   openclaw doctor --checks models
   ```

---

## Still Stuck?

- Check logs: `openclaw logs --tail 100`
- Run diagnostics: `openclaw doctor`
- Visit [Discord](https://discord.gg/clawd) for community support
- Consult [Full Documentation](https://docs.openclaw.ai)
