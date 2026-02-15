---
name: rebase-upstream
description: Rebase the current branch onto an upstream tag or ref, resolving conflicts with upstream-first strategy and verifying builds at each step.
---

# Rebase Upstream

## Overview

Rebase the current feature/chore branch onto a new upstream release tag.
This is used when `upstream` (openclaw/openclaw) publishes a new version and the fork branch needs to catch up.

## Inputs

- **ref**: tag name or branch (e.g. `v2026.2.14`). Ask if not provided.
- **remote**: defaults to `upstream`. Confirm with `git remote -v`.

## Safety

- Never force-push without explicit user confirmation.
- Never skip pre-commit hooks (`--no-verify`).
- Always build (`pnpm build`) before continuing past each conflicted commit.
- Keep a clean working tree between steps.

## Build System

This repo uses **pnpm** (not npm/yarn). Always follow the README:

```sh
pnpm install   # only needed once or after dependency changes
pnpm build     # tsdown + tsc for plugin-sdk DTS + post-build scripts
```

Never use `npx tsc --noEmit` as a substitute -- it misses bundler and post-build steps.

## Execution Contract

### 1. Fetch and start rebase

```sh
git fetch upstream --tags
git rebase v2026.X.Y    # or whatever ref
```

### 2. For each conflicted commit

1. **Identify conflicts**: `git status --short` (look for `UU` files).
2. **Read every conflicted file** before editing -- understand both sides.
3. **Resolve conflicts** following the strategy below.
4. **Verify no conflict markers remain**: `grep -rn '^<{7}\|^>{7}\|^={7}' src/ extensions/` (ignore decorative lines in scripts).
5. **Build**: `pnpm build` -- must pass before continuing.
6. **Stage**: `git add <resolved files>`.
7. **Continue**: `git rebase --continue`.

### 3. After all commits land

- Run tests: `pnpm test` (or the specific test suites relevant to changes).
- Fix any test regressions introduced by the rebase.

## Conflict Resolution Strategy

### General principle: upstream-first

HEAD (upstream/tag) represents the latest released code. It has the authoritative
structure, refactored modules, and new features. Incoming commits (the branch)
add fork-specific features on top.

**Keep HEAD's structure; integrate incoming's new features into it.**

### Pattern: upstream refactored, incoming made minor fixes to old code

If upstream extracted code into new modules (e.g. split `monitor.ts` into
`monitor-normalize.ts`, `monitor-processing.ts`, etc.) and the incoming commit
only made minor type-cast or cleanup changes to the old monolithic code:

**Resolution**: Keep HEAD entirely. The incoming changes are moot because
the code they touched no longer exists in that form.

### Pattern: both sides added new fields/features

Example: HEAD adds `activity`, `status`, `activityType` fields; incoming adds
`mux` field to the same config type.

**Resolution**: Keep both. Add all fields from both sides.

### Pattern: upstream uses extracted helper; incoming inlines the same logic

Example: HEAD imports `resolveWhatsAppOutboundTarget` from a new module;
incoming defines the same logic inline (often with bugs like missing
`missingTargetError` imports).

**Resolution**: Keep HEAD's extracted helper. It's cleaner and tested.

### Pattern: incoming adds mux routing to outbound adapters

The mux routing pattern adds `cfg`, `sessionKey` params and an
`isMuxEnabled()` guard before the direct send path. HEAD may have added
`silent` param to the same methods.

**Resolution**: Merge both -- add `cfg`, `sessionKey`, `silent` to the
parameter destructuring. Place the `isMuxEnabled` block before the
direct-send fallback. Keep `silent` in the direct-send options.

```typescript
sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent, sessionKey }) => {
  if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
    const result = await sendViaMux({ cfg, channel: "discord", ... });
    return { channel: "discord", ...result };
  }
  // direct send (HEAD's path, keeps silent)
  const send = deps?.sendDiscord ?? sendMessageDiscord;
  const result = await send(to, text, { ..., silent: silent ?? undefined });
  return { channel: "discord", ...result };
},
```

### Pattern: schema refactoring (shared schema vs inline)

HEAD may extract a `SharedSchema` and use `.extend()` for account/config
schemas. Incoming may have the full schema inlined (pre-refactoring).

**Resolution**: Keep HEAD's `.extend()` pattern. Add any new fields from
incoming (e.g. `mux: ChannelMuxSchema`) to the appropriate schema level.

### Pattern: extension files duplicate core outbound

Extension files (`extensions/*/src/channel.ts`) define their own outbound
adapters that mirror core adapters (`src/channels/plugins/outbound/*.ts`).
Extensions import from `"openclaw/plugin-sdk"` and cannot use internal modules.

**Resolution**: Apply the same merge to both. For functions not available
from the plugin-sdk (e.g. `buildTelegramRawSend`), keep them inline in
the extension file.

### Pattern: function signature in HEAD, body uses new params after conflict

When the conflict is only in the function signature but the non-conflicted
body after it references `cfg`, `sessionKey`, etc., you **must** include
those params in the merged signature or the code won't compile.

### Pattern: version/description in package.json

**Resolution**: Always keep HEAD's version and description.

### Pattern: .gitignore

**Resolution**: Keep entries from both sides. Use HEAD's path style
(e.g. `/local/` with leading slash).

## Files That Commonly Conflict

| Area               | Files                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Config types       | `src/config/types.discord.ts`, `types.whatsapp.ts`, `types.telegram.ts`                   |
| Zod schemas        | `src/config/zod-schema.providers-core.ts`, `zod-schema.providers-whatsapp.ts`             |
| Core outbound      | `src/channels/plugins/outbound/discord.ts`, `telegram.ts`, `whatsapp.ts`                  |
| Extension outbound | `extensions/discord/src/channel.ts`, `telegram/src/channel.ts`, `whatsapp/src/channel.ts` |
| Gateway            | `src/gateway/hooks.ts`, `server-http.ts`                                                  |
| CLI onboarding     | `src/cli/program/register.onboard.ts`, `src/commands/auth-choice-options.ts`              |
| Infra              | `src/infra/outbound/deliver.ts`, `device-identity.ts`                                     |
| Metadata           | `package.json`, `.gitignore`                                                              |

## Common Post-Merge Type Errors

- **Missing `sessionKey` on param types**: The incoming mux commits add
  `sessionKey` usage in function bodies that were auto-merged, but the
  param type definitions may be in a conflict block you resolved. Check
  that `sessionKey` appears in both the type definition and the usage site.

- **`string | null` vs `string | undefined`**: Outer delivery functions
  accept `sessionKey?: string | null` but inner helpers may only accept
  `string | undefined`. Match the types.

- **Missing test imports**: Incoming test files may use `vi` (vitest)
  without importing it. Check new test files for complete imports.

## Excluding Files from the Repo

If a commit introduces a file that should not be tracked (e.g. `openclaw.tgz`):

1. Ensure it's in `.gitignore`.
2. If HEAD already deleted it, the deletion is preserved automatically.
3. No special action needed beyond resolving the `.gitignore` conflict.

## Guardrails

- Do not skip commits (`git rebase --skip`) without user approval.
- Do not abort the rebase without user approval.
- If a commit's changes are entirely superseded by upstream, confirm with the user before dropping.
- After the full rebase, run the test suite and fix any regressions before declaring done.
