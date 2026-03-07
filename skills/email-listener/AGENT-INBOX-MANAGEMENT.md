# Agent Email Inbox Management Protocol

This document defines the inbox management protocol for AI agents controlling email inboxes in the FrankOS ecosystem.

## Overview

When giving an AI agent control of an email inbox, clear operational rules, classification logic, and repeatable procedures must be defined. Think of it like a **runbook for a junior system administrator**. The agent needs explicit definitions for what "clean" means and how to achieve it.

## Objective

The agent is responsible for maintaining a **clean and actionable inbox**.

### Definition of Clean Inbox

An inbox is considered clean when:

- No unread emails remain
- Every email is **processed and categorized**
- Emails are either:
  - Archived
  - Replied to
  - Converted into tasks
  - Filed into folders
  - Marked as spam
  - Deleted

The inbox should contain **only items requiring immediate human attention**.

---

## Email Processing Loop

The agent must run the following loop whenever new email is detected.

```
1. Check inbox for unread messages
2. For each message:
   a. Read the message
   b. Determine classification
   c. Execute the correct action
3. Verify inbox state
4. Repeat on schedule
```

### Typical Schedule

- Every **1-5 minutes**
- Or event-driven via IMAP push

---

## Email Classification

Every email must be placed into one of the following categories.

| Category | Description | Action |
|----------|-------------|--------|
| Command | Email contains a structured instruction (e.g., `TIM:` command) | Execute command |
| Task | Something that requires work or follow-up | Create task |
| Informational | Newsletters, notifications, reports | Archive |
| Human Required | Needs a human response | Flag and leave in inbox |
| Spam | Unwanted email | Move to spam |
| Junk System Mail | Receipts, automated confirmations | Archive |

---

## Processing Actions

### Command Email

Example:

```
Subject: TIM: Backup Server Status
```

Agent should:

1. Parse command
2. Execute task
3. Send response email
4. Archive original email

### Task Email

Example:

```
Subject: Review security audit
```

Agent should:

1. Extract task
2. Create task entry (Obsidian / ledger / ticket system)
3. Add reference to email
4. Archive email

### Informational Email

Examples:

- Newsletters
- System reports
- Notifications

Agent should: **archive immediately**

No inbox clutter.

### Human Required

Examples:

- Personal message
- Complex decision required

Agent should: **mark as flagged, unread, keep in inbox**

Optional: Send notification to user.

### Spam

Agent should: **move to spam folder**

---

## Folder Structure

The agent should maintain this structure:

```
Inbox
Commands
Tasks
Archive
Notifications
Spam
REVIEW
```

### Rules

- Inbox should stay **near zero**
- Everything processed goes elsewhere

---

## Inbox Hygiene Rules

The agent must enforce these rules:

1. **Never leave processed mail in the inbox**
2. **Archive aggressively**
3. **Only leave items requiring human attention**
4. **No unread messages allowed**
5. **Inbox target: 0-3 emails**

---

## Agent Verification Step

After processing, agent runs validation:

```
Inbox Status Check

Unread emails: 0
Flagged emails: 1
Inbox count: 1

Status: CLEAN
```

If inbox > threshold:

```
Status: NEEDS PROCESSING
```

---

## Error Handling

If an email cannot be classified:

```
Move to folder: REVIEW
```

And notify the user.

---

## Agent Instructions

You can give agents instructions like this:

```
You are responsible for maintaining a clean inbox.

Definition of clean inbox:
- No unread emails
- Only emails requiring human attention remain
- All others must be archived or categorized

Processing workflow:
1. Read email
2. Classify email
3. Take action
4. Remove from inbox

The inbox must remain at or near zero messages.
```

---

## Command Prefixes

Supported agent command prefixes:

```
TIM:
CHEWIE:
FRANKOS:
```

Example:

```
TIM: Generate weekly security report
```

---

## Automatic Task Creation

Email can be converted to Obsidian tasks:

```markdown
- [ ] Review server logs
  source: email
  sender: admin@example.com
```

---

## Agent Response Template

Agent replies with:

```
Command received.
Task executed.
Result attached.
```

---

## Simple Mental Model

> The inbox is **not storage**.
> The inbox is **a temporary queue of unprocessed work**.

Once processed, the email **must leave the inbox**.

---

## Why This Works

In the FrankOS multi-agent system:

- Email becomes a **command bus**
- Inbox becomes a **task queue**
- Agents process messages like **jobs in a scheduler**

It's basically **message-queue architecture disguised as email**.

---

## Implementation

This protocol is implemented in the following modules:

- [`src/inbox-manager.ts`](src/inbox-manager.ts) - Core inbox management logic
- [`src/folder-manager.ts`](src/folder-manager.ts) - Folder operations
- [`src/task-creator.ts`](src/task-creator.ts) - Task creation and Obsidian integration
- [`src/classify_message.ts`](src/classify_message.ts) - Email classification

---

## API Reference

### Inbox Manager

```typescript
import { getAgentInstructions, getInboxStatus, verifyInboxClean } from './inbox-manager';

// Get full agent instructions
const instructions = getAgentInstructions();

// Get current inbox status
const status = getInboxStatus(connection);

// Verify inbox is clean
const verification = await verifyInboxClean(connection);
```

### Folder Manager

```typescript
import { ensureFolderStructure, archiveEmail, moveToSpam } from './folder-manager';

// Ensure folder structure exists
await ensureFolderStructure(config);

// Archive an email
await archiveEmail(connection, messageUid);

// Move to spam
await moveToSpam(connection, messageUid);
```

### Task Creator

```typescript
import { createTask, extractTaskFromEmail, exportTasksToObsidian } from './task-creator';

// Create a task from email
const task = await createTask({
  title: 'Review security audit',
  description: 'Please review the Q4 security audit report',
  priority: 'high',
  sourceEmail: { subject, from, date }
});

// Export tasks to Obsidian format
const obsidianTasks = exportTasksToObsidian();
```

### Classification

```typescript
import { classifyForInbox, getInboxCategoryName } from './classify_message';

// Classify email for inbox management
const classification = classifyForInbox(email);

// Get category display name
const name = getInboxCategoryName(classification.category);
```
