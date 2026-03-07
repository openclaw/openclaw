# Email Cleanup Implementation Plan

## Problem Statement
Tim's inbox is not getting cleaned up - the cron job is not working. After investigation, found that **no cleanup mechanism exists** in the email-listener skill. The current implementation only marks emails as seen after processing.

## Solution
Implement an email cleanup mechanism in the email-listener skill that:
1. Tracks processed emails 
2. Runs on a configurable schedule (like a cron job)
3. Moves processed emails to trash or deletes them after a configurable retention period

## Implementation Tasks

### T001: Add cleanup configuration to config.ts
- Add cleanup settings to EmailListenerConfig interface
- Settings: enabled, intervalMs, retentionPeriodMs, action (trash|delete)

### T002: Add cleanup function to poll_inbox.ts
- Add function to move emails to trash or delete them
- Use imap-simple move or delete operations

### T003: Add cleanup scheduler to index.ts
- Add setInterval-based cleanup scheduler
- Track processed email UIDs for cleanup
- Run cleanup on configurable interval

### T004: Test the cleanup mechanism
- Verify emails are moved/deleted after retention period
- Verify no unintended deletions occur

## File Changes
- `skills/email-listener/src/config.ts` - Add cleanup config
- `skills/email-listener/src/poll_inbox.ts` - Add delete/move functions  
- `skills/email-listener/src/index.ts` - Add cleanup scheduler
