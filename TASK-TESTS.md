# Task: Write tests for message_sent hook wiring

## Context

We wired the `message_sent` plugin hook which was previously dead code (defined but never called).
The hook is now called in two places:

1. **`src/auto-reply/reply/reply-dispatcher.ts`** — centralised, fires after every successful `options.deliver()` call
2. **`src/infra/outbound/deliver.ts`** — fires after `deliverOutboundPayloads()` completes (for cron/heartbeat paths)

## What to test

### 1. reply-dispatcher tests (NEW FILE: `src/auto-reply/reply/reply-dispatcher.test.ts`)

- When a reply is delivered successfully, `runMessageSent` is called with the message content
- When `hookContext` is provided, it's passed through to the hook context
- When delivery fails (options.deliver throws), `runMessageSent` is NOT called
- When normalized text is empty, `runMessageSent` is NOT called
- `runMessageSent` errors don't break delivery (fire-and-forget)

### 2. deliver.ts tests (ADD TO: `src/infra/outbound/deliver.test.ts`)

- After successful delivery, `runMessageSent` is called with combined text from all payloads
- `runMessageSent` errors don't propagate to caller

## Code patterns to follow

- Use vitest (vi.mock, vi.fn, describe/it/expect)
- Mock `getGlobalHookRunner` from `../../plugins/hook-runner-global.js`
- Look at existing test patterns in `src/infra/outbound/deliver.test.ts`
- Look at `src/gateway/hooks.test.ts` for hook testing patterns

## Important

- Run `pnpm build && pnpm test` to verify everything passes
- Don't modify any source files, only add/modify test files
- Follow existing code style (the repo uses oxlint + oxfmt)

When completely finished, run: openclaw gateway wake --text "Done: Tests written for message_sent hook wiring" --mode now
