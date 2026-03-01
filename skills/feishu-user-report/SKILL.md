---
name: feishu-user-report
description: Handle delayed reporting for Feishu channel users. When a Feishu user asks to report back later because results are not available yet, this skill clarifies that the report must be sent back to the specific Feishu user identified by their Feishu user ID, not just to the channel generally. Use whenever a user from Feishu channel requests to report back later, results need to be delivered asynchronously to a specific Feishu user, or you need to remember which Feishu user to report back to.
---

# Feishu User Report

This skill ensures that when Feishu users request delayed reporting, the results are delivered to the correct individual user, not just broadcast to a channel.

## Core Principle

When a Feishu user says something like:

- "Report back to me later"
- "Let me know when you have the results"
- "Come back to me when this is done"
- "I'll check back later, just let me know"

**Always**:

1. Capture and store the user's Feishu user ID (not just their name)
2. When results are ready, send the report directly to that specific user ID
3. Do NOT just send to the channel generally - direct message the user

## How to Identify the User

From Feishu channel messages, you will have access to the sender's user ID. Always:

- Store this ID alongside any pending task
- Use this exact ID when sending the delayed report
- Never rely solely on user names (they can change or be duplicated)

## Example Workflow

1. User (Feishu ID: `ou_123456789`) says: "Find that document and report back to me later"
2. You store: `{ task: "find document", userId: "ou_123456789" }`
3. Later, when you find the document:
4. Use the message tool with the specific user ID to deliver the result directly

## Important Reminder

Feishu has both group channels and direct messages. When a user asks to "report back later" from a group channel, you still need to send the result to that specific user (via direct message or @mention with user ID), not just post it in the group where it might be missed.
