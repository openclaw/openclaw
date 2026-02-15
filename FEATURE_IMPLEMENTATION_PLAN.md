# OpenClaw 6-Feature Implementation Plan

## Overview

Implementing 6 improvements to OpenClaw in feature branches, then merging to main.

## Features

### 1. Channel Name Resolution (feat/channel-name-resolution)

**Goal:** Auto-resolve Slack channel names to IDs with caching.

**Files to Create/Modify:**

- `src/slack/channel-cache.ts` (NEW) - Cache management
- `src/infra/outbound/targets.ts` - Enhance target resolution to support channel names
- `src/channels/plugins/slack-plugin.ts` - Add channel name resolution to plugin

**Changes:**

- Cache channel list on gateway startup
- Support both names and IDs in message tool transparently
- Expires after 1 hour or on manual reset

---

### 2. Model Switch Workflow Automation (feat/model-switch-automation)

**Goal:** Auto-promote to higher-tier models when needed, with approval workflow.

**Files to Create/Modify:**

- `src/gateway/model-switching.ts` (NEW) - Complexity detection and promotion logic
- `src/gateway/model-tiering.ts` - Enhance existing tiering system
- `src/infra/outbound/message-action-runner.ts` - Add reaction monitoring for approvals

**Changes:**

- Detect: context > 50%, multiple failed attempts, token budget exceeded
- Auto-post to alfred-approvals channel with justification
- Monitor for ✅ reaction to approve model switch
- Auto-revert to haiku after task completion

---

### 3. Cost Alert Thresholds (feat/cost-alerts)

**Goal:** Alert when session/daily costs exceed configured thresholds.

**Files to Create/Modify:**

- `src/config/config.ts` - Add costAlerts config schema
- `src/infra/session-cost-alerts.ts` (NEW) - Alert management
- `src/commands/usage-by-model.ts` (NEW) - Implement `/usage by-model` command

**Changes:**

- Add `costAlerts.sessionThreshold` and `costAlerts.dailyThreshold` to config
- Alert via Slack DM when exceeded
- Implement `/usage by-model` command support in CLI

---

### 4. Better Error Context (feat/error-context-enhancement)

**Goal:** Add session key and operation tracing to all error logs.

**Files to Create/Modify:**

- `src/logging/error-logger.ts` (NEW) - Centralized error logging with session context
- `src/logging/operation-trace.ts` (NEW) - Operation tracking
- `src/infra/outbound/message.ts` - Use enhanced logging
- `src/gateway/call.ts` - Sanitize errors before Slack delivery

**Changes:**

- Include session key in all error logs
- Trace operation that triggered the error
- Sanitize stack traces before sending to Slack
- Implement structured error context

---

### 5. Session Recovery (feat/session-recovery)

**Goal:** Save and restore session state during long operations.

**Files to Create/Modify:**

- `src/infra/session-checkpoint.ts` (NEW) - Checkpoint/restore logic
- `src/infra/outbound/outbound-session.ts` - Add checkpoint() and restore() methods
- `src/gateway/gateway.ts` - Call restore() on startup

**Changes:**

- Save checkpoint state at key operation points
- Auto-resume on gateway restart
- Add public `session.checkpoint()` and `session.restore()` methods
- Store checkpoints in ~/.openclaw/checkpoints/

---

### 6. Workspace Sync (feat/workspace-sync)

**Goal:** Auto-commit memory files to private git repo.

**Files to Create/Modify:**

- `src/config/config.ts` - Add workspace.syncRepo config
- `src/infra/workspace-sync.ts` (NEW) - Git sync logic
- `src/daemon/memory-sync-scheduler.ts` (NEW) - Hourly sync scheduler

**Changes:**

- Auto-commit memory files every hour if changed
- Configure private repo in config: `workspace.syncRepo`
- Pull on startup if remote is ahead
- Implement robust git error handling

---

## Implementation Order

1. **Channel Name Resolution** (easiest, no dependencies)
2. **Better Error Context** (foundation for other features)
3. **Cost Alert Thresholds** (independent)
4. **Session Recovery** (independent)
5. **Model Switch Workflow Automation** (uses error context)
6. **Workspace Sync** (independent)

## Testing Strategy

- Unit tests for each new module
- Integration tests for feature interactions
- Compilation check before merging each branch
- Manual testing for workflow automation

## Merge Strategy

- Create feature branch for each feature
- Test individually
- Merge to main after validation
- Push to GitHub after all 6 are merged
