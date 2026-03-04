# WhatsApp: Separate Outbound `allowSendTo` from Inbound `allowFrom`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow WhatsApp outbound sends to any number while keeping inbound restricted via `allowFrom` — by adding a new `allowSendTo` config field.

**Architecture (Approach A — Generic):** Add `allowSendTo` as a first-class concept in the outbound adapter pipeline, not a WhatsApp-only hack. The `ChannelOutboundAdapter.resolveTarget` interface gains an optional `allowSendTo` parameter. The generic `resolveOutboundTarget` resolves it via a new `resolveAllowSendTo` config adapter method. WhatsApp is the first (and only for now) channel to implement it. Other channels ignore it — fully backward compatible.

**Tech Stack:** TypeScript, Vitest

**Fixes:** GitHub issues #30087, #25039

**Key design decision:** When `allowSendTo` is defined, it completely **replaces** `allowFrom` for outbound checks. When undefined, behavior is identical to current (uses `allowFrom`). This means `allowSendTo: ["*"]` = unrestricted outbound, `allowSendTo: []` = block all outbound.

---

## Files touched (complete list)

| File                                             | Change                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/config/types.whatsapp.ts`                   | Add `allowSendTo` field                                                              |
| `src/web/accounts.ts`                            | Add to `ResolvedWhatsAppAccount` type + resolution                                   |
| `src/plugin-sdk/channel-config-helpers.ts`       | Add `resolveWhatsAppConfigAllowSendTo` helper                                        |
| `src/whatsapp/resolve-outbound-target.ts`        | Accept + use `allowSendTo`                                                           |
| `src/whatsapp/resolve-outbound-target.test.ts`   | New tests for `allowSendTo`                                                          |
| `src/channels/plugins/types.adapters.ts`         | Add `allowSendTo` to `resolveTarget` params + `resolveAllowSendTo` to config adapter |
| `src/channels/plugins/outbound/whatsapp.ts`      | Pass `allowSendTo` through                                                           |
| `src/infra/outbound/targets.ts`                  | Resolve + pass `allowSendTo` in generic pipeline                                     |
| `src/channels/dock.ts`                           | Wire `resolveAllowSendTo` for WhatsApp dock + update Pick type                       |
| `src/agents/tools/whatsapp-target-auth.ts`       | Pass `allowSendTo` from account config                                               |
| `src/cron/isolated-agent/delivery-target.ts`     | Pass `allowSendTo` in cron delivery                                                  |
| `extensions/whatsapp/src/channel.ts`             | Pass `allowSendTo` in plugin adapter                                                 |
| `extensions/whatsapp/src/resolve-target.test.ts` | Update plugin adapter tests                                                          |
| `src/plugin-sdk/index.ts`                        | Export `resolveWhatsAppConfigAllowSendTo` from barrel                                |
| `src/config/zod-schema.providers-whatsapp.ts`    | Add `allowSendTo` to WhatsApp config validation schema                               |

---

## Task 1: Add `allowSendTo` to config types + account resolution

**Files:**

- Modify: `src/config/types.whatsapp.ts`
- Modify: `src/web/accounts.ts`
- Modify: `src/plugin-sdk/channel-config-helpers.ts`

**Step 1: Add field to `WhatsAppSharedConfig`**

In `src/config/types.whatsapp.ts`, in `WhatsAppSharedConfig` after `allowFrom` (line 46), add:

```typescript
/** Optional allowlist for outbound WhatsApp sends (E.164). When set, overrides allowFrom for outbound target resolution. Use ["*"] for unrestricted outbound. */
allowSendTo?: string[];
```

**Step 2: Add to `ResolvedWhatsAppAccount` type**

In `src/web/accounts.ts`, after `allowFrom?: string[]` (line 21), add:

```typescript
allowSendTo?: string[];
```

**Step 3: Add to `resolveWhatsAppAccount` return**

In `src/web/accounts.ts`, after line 137 (`allowFrom: ...`), add:

```typescript
allowSendTo: accountCfg?.allowSendTo ?? rootCfg?.allowSendTo,
```

**Step 4: Add config helper**

In `src/plugin-sdk/channel-config-helpers.ts`, after `resolveWhatsAppConfigAllowFrom` function, add:

```typescript
export function resolveWhatsAppConfigAllowSendTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] | undefined {
  return resolveWhatsAppAccount(params).allowSendTo;
}
```

**Step 5: Commit**

```bash
scripts/committer "WhatsApp: add allowSendTo config type and account resolution" src/config/types.whatsapp.ts src/web/accounts.ts src/plugin-sdk/channel-config-helpers.ts
```

---

## Task 2: Update the core outbound resolver (TDD)

**Files:**

- Modify: `src/whatsapp/resolve-outbound-target.ts`
- Modify: `src/whatsapp/resolve-outbound-target.test.ts`

**Step 1: Write failing tests**

Update test helpers `expectAllowedForTarget` and `expectDeniedForTarget` to accept optional `allowSendTo`:

```typescript
function expectAllowedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
  allowSendTo?: ResolveParams["allowSendTo"];
}) {
  const to = params.to ?? PRIMARY_TARGET;
  expectResolutionOk(
    { to, allowFrom: params.allowFrom, mode: params.mode, allowSendTo: params.allowSendTo },
    to,
  );
}

function expectDeniedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
  allowSendTo?: ResolveParams["allowSendTo"];
}) {
  expectResolutionError({
    to: params.to ?? PRIMARY_TARGET,
    allowFrom: params.allowFrom,
    mode: params.mode,
    allowSendTo: params.allowSendTo,
  });
}
```

Add new `describe` block:

```typescript
describe("allowSendTo override", () => {
  it("allows message when target is in allowSendTo even if not in allowFrom", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET, PRIMARY_TARGET);
    expectAllowedForTarget({
      allowFrom: [SECONDARY_TARGET],
      mode: "implicit",
      allowSendTo: [PRIMARY_TARGET],
    });
  });

  it("denies message when target is not in allowSendTo even if in allowFrom", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET, SECONDARY_TARGET);
    expectDeniedForTarget({
      allowFrom: [PRIMARY_TARGET],
      mode: "implicit",
      allowSendTo: [SECONDARY_TARGET],
    });
  });

  it("allows any target when allowSendTo contains wildcard", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET);
    expectAllowedForTarget({
      allowFrom: [SECONDARY_TARGET],
      mode: "implicit",
      allowSendTo: ["*"],
    });
  });

  it("falls back to allowFrom when allowSendTo is undefined", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
    expectAllowedForTarget({
      allowFrom: [PRIMARY_TARGET],
      mode: "implicit",
      allowSendTo: undefined,
    });
  });

  it("falls back to allowFrom when allowSendTo is undefined and target not in list", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET);
    expectDeniedForTarget({
      allowFrom: [SECONDARY_TARGET],
      mode: "implicit",
      allowSendTo: undefined,
    });
  });

  it("blocks all outbound when allowSendTo is empty array", () => {
    mockNormalizedDirectMessage(PRIMARY_TARGET);
    expectDeniedForTarget({
      allowFrom: ["*"],
      mode: "implicit",
      allowSendTo: [],
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm vitest run src/whatsapp/resolve-outbound-target.test.ts
```

Expected: FAIL (allowSendTo not in params type yet)

**Step 3: Implement the change**

Replace `resolveWhatsAppOutboundTarget` in `src/whatsapp/resolve-outbound-target.ts`:

```typescript
export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  allowSendTo?: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";

  // When allowSendTo is explicitly defined, use it for outbound checks.
  // Otherwise fall back to allowFrom (legacy behavior).
  const outboundListRaw = (
    params.allowSendTo !== undefined && params.allowSendTo !== null
      ? params.allowSendTo
      : (params.allowFrom ?? [])
  )
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const hasWildcard = outboundListRaw.includes("*");
  const outboundList = outboundListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (trimmed) {
    const normalizedTo = normalizeWhatsAppTarget(trimmed);
    if (!normalizedTo) {
      return {
        ok: false,
        error: missingTargetError("WhatsApp", "<E.164|group JID>"),
      };
    }
    if (isWhatsAppGroupJid(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    if (hasWildcard || outboundList.length === 0) {
      return { ok: true, to: normalizedTo };
    }
    if (outboundList.includes(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID>"),
    };
  }

  return {
    ok: false,
    error: missingTargetError("WhatsApp", "<E.164|group JID>"),
  };
}
```

**Step 4: Run tests**

```bash
pnpm vitest run src/whatsapp/resolve-outbound-target.test.ts
```

Expected: ALL PASS

**Step 5: Commit**

```bash
scripts/committer "WhatsApp: support allowSendTo in outbound target resolver" src/whatsapp/resolve-outbound-target.ts src/whatsapp/resolve-outbound-target.test.ts
```

---

## Task 3: Wire `allowSendTo` through the generic outbound adapter interface

**Files:**

- Modify: `src/channels/plugins/types.adapters.ts`
- Modify: `src/infra/outbound/targets.ts`
- Modify: `src/channels/dock.ts`

**Step 1: Update `resolveTarget` params in adapter interface**

In `src/channels/plugins/types.adapters.ts`, inside `ChannelOutboundAdapter.resolveTarget` params (line 116), after `allowFrom?: string[];`:

```typescript
allowSendTo?: string[];
```

**Step 2: Add `resolveAllowSendTo` to `ChannelConfigAdapter`**

In `src/channels/plugins/types.adapters.ts`, inside `ChannelConfigAdapter` type (after `resolveAllowFrom`), add:

```typescript
resolveAllowSendTo?: (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => string[] | undefined;
```

**Step 3: Update `ChannelDock` Pick type**

In `src/channels/dock.ts` line 65-68, update the Pick:

```typescript
config?: Pick<
  ChannelConfigAdapter<unknown>,
  "resolveAllowFrom" | "resolveAllowSendTo" | "formatAllowFrom" | "resolveDefaultTo"
>;
```

**Step 4: Wire `resolveAllowSendTo` for WhatsApp in dock.ts**

In `src/channels/dock.ts`, in the WhatsApp dock entry, after `resolveAllowFrom` (line 297), add:

```typescript
resolveAllowSendTo: ({ cfg, accountId }) => resolveWhatsAppConfigAllowSendTo({ cfg, accountId }),
```

Add the import for `resolveWhatsAppConfigAllowSendTo` from `../plugin-sdk/channel-config-helpers.js`.

**Step 5: Update `resolveOutboundTarget` in targets.ts**

In `src/infra/outbound/targets.ts`, function `resolveOutboundTarget` (line 170):

Add `allowSendTo?: string[];` to the params type.

After the `allowFrom` resolution block (lines 198-206), add:

```typescript
const allowSendToRaw =
  params.allowSendTo ??
  (params.cfg && plugin.config.resolveAllowSendTo
    ? plugin.config.resolveAllowSendTo({
        cfg: params.cfg,
        accountId: params.accountId ?? undefined,
      })
    : undefined);
const allowSendTo = allowSendToRaw?.map((entry) => String(entry));
```

Update the `resolveTarget` call (lines 220-226) to pass `allowSendTo`:

```typescript
return resolveTarget({
  cfg: params.cfg,
  to: effectiveTo,
  allowFrom,
  allowSendTo,
  accountId: params.accountId ?? undefined,
  mode: params.mode ?? "explicit",
});
```

**Step 6: Commit**

```bash
scripts/committer "WhatsApp: wire allowSendTo through generic outbound adapter pipeline" src/channels/plugins/types.adapters.ts src/infra/outbound/targets.ts src/channels/dock.ts
```

---

## Task 4: Update WhatsApp outbound adapters (core + extension plugin)

**Files:**

- Modify: `src/channels/plugins/outbound/whatsapp.ts`
- Modify: `extensions/whatsapp/src/channel.ts`
- Modify: `extensions/whatsapp/src/resolve-target.test.ts`

**Step 1: Update core outbound adapter**

In `src/channels/plugins/outbound/whatsapp.ts` line 14-15:

```typescript
resolveTarget: ({ to, allowFrom, allowSendTo, mode }) =>
  resolveWhatsAppOutboundTarget({ to, allowFrom, allowSendTo, mode }),
```

**Step 2: Update extension plugin adapter**

In `extensions/whatsapp/src/channel.ts` line 287-288:

```typescript
resolveTarget: ({ to, allowFrom, allowSendTo, mode }) =>
  resolveWhatsAppOutboundTarget({ to, allowFrom, allowSendTo, mode }),
```

**Step 3: Update extension plugin tests**

In `extensions/whatsapp/src/resolve-target.test.ts`, add test cases for `allowSendTo` behavior (mirroring the core tests from Task 2). At minimum add a test that `allowSendTo: ["*"]` allows any target even when `allowFrom` is restrictive.

**Step 4: Commit**

```bash
scripts/committer "WhatsApp: pass allowSendTo in core and extension outbound adapters" src/channels/plugins/outbound/whatsapp.ts extensions/whatsapp/src/channel.ts extensions/whatsapp/src/resolve-target.test.ts
```

---

## Task 5: Wire `allowSendTo` in agent tool authorization

**Files:**

- Modify: `src/agents/tools/whatsapp-target-auth.ts`

**Step 1: Pass `allowSendTo` from account config**

Replace `resolveAuthorizedWhatsAppOutboundTarget`:

```typescript
export function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): { to: string; accountId: string } {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const resolution = resolveWhatsAppOutboundTarget({
    to: params.chatJid,
    allowFrom: account.allowFrom ?? [],
    allowSendTo: account.allowSendTo,
    mode: "implicit",
  });
  if (!resolution.ok) {
    throw new ToolAuthorizationError(
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowSendTo/allowFrom list for account "${account.accountId}".`,
    );
  }
  return { to: resolution.to, accountId: account.accountId };
}
```

**Step 2: Commit**

```bash
scripts/committer "WhatsApp: wire allowSendTo in agent tool authorization" src/agents/tools/whatsapp-target-auth.ts
```

---

## Task 6: Wire `allowSendTo` in cron delivery

**Files:**

- Modify: `src/cron/isolated-agent/delivery-target.ts`

**Step 1: Resolve and pass `allowSendTo`**

In the WhatsApp-specific block (lines 151-172), after line 164 (`allowFromOverride = [...]`), add:

```typescript
const allowSendToRaw = resolveWhatsAppAccount({ cfg, accountId: resolvedAccountId }).allowSendTo;
```

In the `resolveOutboundTarget` call (lines 174-181), add `allowSendTo`:

```typescript
const docked = resolveOutboundTarget({
  channel,
  to: toCandidate,
  cfg,
  accountId,
  mode,
  allowFrom: allowFromOverride,
  allowSendTo: allowSendToRaw,
});
```

**Step 2: Commit**

```bash
scripts/committer "WhatsApp: wire allowSendTo in cron delivery target" src/cron/isolated-agent/delivery-target.ts
```

---

## Task 7: Type-check + lint + full test suite

**Step 1: Type-check**

```bash
pnpm tsgo
```

Expected: PASS

**Step 2: Lint + format**

```bash
pnpm check
pnpm format:fix
```

Expected: PASS (fix formatting if needed)

**Step 3: Run full test suite**

```bash
pnpm test
```

Expected: ALL PASS

**Step 4: Fix any issues and commit**

---

## Task 8: Manual integration test

**Step 1: Apply config**

In `~/.openclaw/openclaw.json`, on the `default` account:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["+886920010612"],
  "allowSendTo": ["*"]
}
```

Meaning: only owner can DM in, agent can send to anyone.

**Step 2: Rebuild dist**

```bash
pnpm build
```

**Step 3: Restart gateway**

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

**Step 4: Test outbound send to external number**

```bash
openclaw message send --channel whatsapp --target "<OTHER_PHONE_E164>" --message "Test allowSendTo"
```

Expected: Message delivered successfully (no "requires target" error).

**Step 5: Test inbound still blocked**

Send a WhatsApp message from a number NOT in `allowFrom`. Expected: silently dropped.

**Step 6: Test backward compatibility**

Remove `allowSendTo` from config, restart gateway. Verify behavior is identical to before (outbound restricted to `allowFrom`).

---

## Verification Checklist

- [ ] `pnpm tsgo` passes
- [ ] `pnpm check` passes
- [ ] `pnpm test` passes (all existing + new outbound resolver tests)
- [ ] Extension plugin tests pass (`extensions/whatsapp`)
- [ ] Outbound to non-allowFrom number succeeds when `allowSendTo: ["*"]`
- [ ] Outbound blocked when target not in `allowSendTo` (if set)
- [ ] Inbound from non-allowFrom number still blocked
- [ ] Behavior unchanged when `allowSendTo` is not set (backward compatible)
- [ ] Cron delivery uses `allowSendTo` when set
- [ ] Agent tool send uses `allowSendTo` when set
- [ ] `allowSendTo: []` blocks all outbound (empty = nobody)

---

## PR info

**Branch:** `fix/whatsapp-separate-outbound-allowlist`
**Title:** `WhatsApp: separate outbound allowSendTo from inbound allowFrom`
**Closes:** #30087, #25039
