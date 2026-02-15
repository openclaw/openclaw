# Feature: Gmail Tools

## Priority: 2

## Status: Spec Written

## Description

Multi-account Gmail tools following OpenClaw's existing tool pattern (like slack-actions.ts).
Implements a `handleGmailAction` function that dispatches actions (read, get, search, send,
draft, triage) across multiple Google Workspace accounts (edubites, protaige, zenloop).
Each account uses OAuth 2.0 with refresh tokens. The tool integrates with the people index
for sender identification.

## Acceptance Criteria

1. `handleGmailAction` with action "read" returns unread email summaries from a specified account
2. `handleGmailAction` with action "get" returns full email body and metadata for a message ID
3. `handleGmailAction` with action "search" queries a single account or all accounts in parallel
4. `handleGmailAction` with action "send" sends an email from the correct account, returns message ID
5. `handleGmailAction` with action "draft" creates a Gmail draft without sending, returns draft ID
6. `handleGmailAction` with action "triage" categorizes unread emails into urgent/needs_reply/informational/can_archive
7. Multi-account resolution follows the same pattern as slack accounts (config-based with env fallback)
8. Action gating via config (actions.read, actions.send, etc.) can disable individual actions
9. Invalid/missing parameters throw `ToolInputError` with descriptive messages
10. Unknown actions throw an error with the action name

## Test Cases

| #   | Test                                 | Input                                                                                                       | Expected Output                                                              |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Read inbox returns summaries         | `action:"read", accountId:"edubites"`                                                                       | Returns array of email summaries with from, subject, snippet, date, threadId |
| 2   | Read with count limit                | `action:"read", accountId:"edubites", count:5`                                                              | Gmail API called with maxResults=5                                           |
| 3   | Read unread only (default)           | `action:"read", accountId:"edubites"`                                                                       | Gmail API called with q="is:unread"                                          |
| 4   | Read all (unreadOnly=false)          | `action:"read", accountId:"edubites", unreadOnly:false`                                                     | Gmail API called without unread filter                                       |
| 5   | Read with label filter               | `action:"read", accountId:"edubites", label:"STARRED"`                                                      | Gmail API called with labelIds=["STARRED"]                                   |
| 6   | Get full message                     | `action:"get", accountId:"edubites", messageId:"msg123"`                                                    | Returns full body, attachments list, headers                                 |
| 7   | Get requires messageId               | `action:"get", accountId:"edubites"`                                                                        | Throws ToolInputError("messageId required")                                  |
| 8   | Search single account                | `action:"search", accountId:"edubites", query:"from:thomas"`                                                | Returns matching emails from edubites                                        |
| 9   | Search all accounts                  | `action:"search", accountId:"all", query:"meeting"`                                                         | Returns combined results from all 3 accounts                                 |
| 10  | Search requires query                | `action:"search", accountId:"edubites"`                                                                     | Throws ToolInputError("query required")                                      |
| 11  | Send email                           | `action:"send", accountId:"protaige", to:"a@b.com", subject:"Hi", body:"Hello"`                             | Gmail API send called, returns message ID                                    |
| 12  | Send requires to                     | `action:"send", accountId:"protaige", subject:"Hi", body:"Hello"`                                           | Throws ToolInputError("to required")                                         |
| 13  | Send requires subject                | `action:"send", accountId:"protaige", to:"a@b.com", body:"Hello"`                                           | Throws ToolInputError("subject required")                                    |
| 14  | Send requires body                   | `action:"send", accountId:"protaige", to:"a@b.com", subject:"Hi"`                                           | Throws ToolInputError("body required")                                       |
| 15  | Send reply (with replyToMessageId)   | `action:"send", accountId:"protaige", to:"a@b.com", subject:"Re: Hi", body:"Ok", replyToMessageId:"msg123"` | Gmail API send called with In-Reply-To/References headers                    |
| 16  | Send with cc                         | `action:"send", accountId:"protaige", to:"a@b.com", subject:"Hi", body:"Hello", cc:"c@d.com"`               | Gmail API send called with Cc header                                         |
| 17  | Draft create                         | `action:"draft", accountId:"zenloop", to:"a@b.com", subject:"Hi", body:"Hello"`                             | Gmail drafts.create called, returns draft ID                                 |
| 18  | Draft reply                          | `action:"draft", accountId:"zenloop", to:"a@b.com", subject:"Re: Hi", body:"Ok", replyToMessageId:"msg123"` | Draft created with In-Reply-To header                                        |
| 19  | Triage single account                | `action:"triage", accountId:"edubites"`                                                                     | Returns categorized emails: urgent, needs_reply, informational, can_archive  |
| 20  | Triage all accounts                  | `action:"triage", accountId:"all"`                                                                          | Returns combined triage from all accounts                                    |
| 21  | Unknown action throws                | `action:"archive", accountId:"edubites"`                                                                    | Throws Error("Unknown action: archive")                                      |
| 22  | Action gating - read disabled        | config: `actions.read=false`, `action:"read"`                                                               | Throws Error("Gmail read is disabled.")                                      |
| 23  | Action gating - send disabled        | config: `actions.send=false`, `action:"send"`                                                               | Throws Error("Gmail send is disabled.")                                      |
| 24  | Account resolution - default account | No accountId provided                                                                                       | Uses default account from config                                             |
| 25  | Account resolution - named account   | `accountId:"edubites"`                                                                                      | Resolves edubites account config and tokens                                  |
| 26  | Account resolution - env fallback    | Default account, no config token                                                                            | Falls back to GMAIL_REFRESH_TOKEN env var                                    |

## Dependencies

- Feature 01 (People Index) -- for sender identification in triage (soft dependency, triage works without it)
- Google OAuth 2.0 setup (manual prerequisite per account)
- googleapis npm package (google-auth-library + googleapis)

## Files

### New Files

- `src/gmail/client.ts` -- Gmail API client wrapper (auth, token refresh)
- `src/gmail/actions.ts` -- Gmail action functions (listMessages, getMessage, sendMessage, createDraft, searchMessages)
- `src/gmail/accounts.ts` -- Multi-account resolution (like slack/accounts.ts)
- `src/gmail/types.ts` -- TypeScript types for Gmail messages, summaries, triage results
- `src/gmail/token.ts` -- Token resolution (config + env fallback)
- `src/agents/tools/gmail-actions.ts` -- Tool handler (handleGmailAction, like slack-actions.ts)
- `src/agents/tools/gmail-actions.e2e.test.ts` -- Tests for handleGmailAction
- `src/gmail/accounts.test.ts` -- Tests for account resolution
- `src/config/types.gmail.ts` -- GmailConfig, GmailAccountConfig, GmailActionConfig types

### Modified Files

- `src/config/types.channels.ts` -- Add `gmail?: GmailConfig` to ChannelsConfig
- `src/config/types.ts` -- Re-export types.gmail.ts

## Notes

### Architecture Decisions

- Follow the exact same pattern as Slack tools: `handleGmailAction` dispatches by action string
- Use `createActionGate` from common.ts for action gating
- Use `readStringParam`, `readNumberParam` from common.ts for parameter parsing
- Use `jsonResult` from common.ts for return values
- Multi-account config follows `SlackConfig` pattern: base config + `accounts` record
- Gmail API client uses `google-auth-library` for OAuth2 + token refresh
- Triage uses a simple rule-based classifier initially (not LLM-powered) to avoid external dependencies in the core tool

### Config Shape

```json5
{
  channels: {
    gmail: {
      enabled: true,
      clientId: "...",
      clientSecret: "...",
      refreshToken: "...",
      actions: {
        read: true,
        get: true,
        search: true,
        send: true,
        draft: true,
        triage: true,
      },
      accounts: {
        edubites: {
          clientId: "...",
          clientSecret: "...",
          refreshToken: "...",
        },
        protaige: {
          refreshToken: "...",
        },
        zenloop: {
          refreshToken: "...",
        },
      },
    },
  },
}
```

### Security Considerations

- Refresh tokens stored in config file (not in code)
- Send action should require explicit user approval (handled at agent level, not tool level)
- No raw credentials in error messages
- Token refresh errors surfaced as generic "authentication failed" messages

### Out of Scope (Phase 1)

- Gmail Watch (Pub/Sub push notifications) -- separate feature/phase
- Auto-reply rules engine -- separate feature/phase
- Attachment download/upload -- future enhancement
- Label management -- future enhancement

## Blocks

- Feature 07 (Briefings) -- needs Gmail data for morning briefing
