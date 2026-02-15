# Fork Merge Playbook

## Pre-Merge Analysis (Run BEFORE merging)

Before `git merge upstream/main`, analyze what's coming:

```bash
git fetch upstream
BEHIND=$(git log --oneline HEAD..upstream/main | wc -l)
echo "Commits behind: $BEHIND"

# Check which of our modified files upstream also changed
CONFLICT_RISK=""
for f in \
  src/config/zod-schema.providers-whatsapp.ts \
  src/config/types.whatsapp.ts \
  src/auto-reply/types.ts \
  src/auto-reply/reply/get-reply-run.ts \
  src/agents/openclaw-tools.ts \
  src/web/auto-reply/monitor/process-message.ts \
  src/web/auto-reply/monitor/group-gating.ts \
  src/web/session.ts \
  src/web/inbound/monitor.ts \
  package.json \
  extensions/memory-lancedb/config.ts; do
  UPSTREAM_CHANGES=$(git log --oneline HEAD..upstream/main -- "$f" | wc -l)
  if [ "$UPSTREAM_CHANGES" -gt 0 ]; then
    CONFLICT_RISK="$CONFLICT_RISK\n  ⚠️  $f ($UPSTREAM_CHANGES upstream commits)"
  fi
done
echo -e "Conflict risk files:$CONFLICT_RISK"
```

## Our Injections into Upstream Files (Friction Points)

### 1. `src/config/zod-schema.providers-whatsapp.ts` — HIGH FRICTION
**What we add:** `triggerPrefix` and `syncFullHistory` fields in WhatsAppSharedSchema and WhatsAppConfigSchema
**Why it conflicts:** Upstream restructures schema frequently (extracted WhatsAppGroupEntrySchema, WhatsAppAckReactionSchema etc.)
**Resolution:** Accept upstream's version entirely, then re-add our 2-3 lines:
- `triggerPrefix: z.string().optional(),` in WhatsAppSharedSchema
- `syncFullHistory: z.boolean().optional().default(false),` in WhatsAppAccountSchema (after `authDir`)
- `syncFullHistory: z.boolean().optional().default(false),` in WhatsAppConfigSchema (after `actions` block)

### 2. `src/config/types.whatsapp.ts` — HIGH FRICTION
**What we add:** Extended `WhatsAppActionConfig` fields + `triggerPrefix` + `syncFullHistory`
**Resolution:** Check if upstream added WhatsAppActionConfig fields (they may have). Keep our additions only if upstream doesn't have them.

### 3. `src/auto-reply/types.ts` — LOW FRICTION
**What we add:** `execSecurityLevel` field
**Resolution:** Just keep both sides (our field + upstream's new fields)

### 4. `src/auto-reply/reply/get-reply-run.ts` — MEDIUM FRICTION
**What we had:** Local `BARE_SESSION_RESET_PROMPT` const
**Status:** RESOLVED — upstream extracted to `session-reset-prompt.ts`, we now import it. No more local declaration.
**What we still add:** `ExecOverrides` type alias
**Resolution:** Keep both

### 5. `src/agents/openclaw-tools.ts` — LOW FRICTION
**What we add:** Import + registration of `createWhatsAppHistoryTool`
**Resolution:** Just keep our import + tool registration line

### 6. `src/web/auto-reply/monitor/process-message.ts` — MEDIUM FRICTION
**What we add:** Thinking reaction (🤔) hooks
**Status:** Extracted to `thinking-reaction.ts` module — only imports + 3 call sites in process-message.ts
**Resolution:** After merge, verify imports and call sites still present

### 7. `src/web/auto-reply/monitor/group-gating.ts` — LOW FRICTION
**What we add:** Owner media bypass (audio messages skip triggerPrefix)
**Resolution:** Our changes are at the top of the function, unlikely to conflict

### 8. `src/web/session.ts` — LOW FRICTION
**What we add:** `markOnlineOnConnect: true`
**Resolution:** One-line change, easy to re-apply

### 9. `src/web/inbound/monitor.ts` — MEDIUM FRICTION
**What we add:** `sendPresenceUpdate("available")` before composing
**Resolution:** Locate the composing block, add one line before it

### 10. `package.json` — HIGH FRICTION (72 upstream commits/month!)
**What we add:** `better-sqlite3` dependency
**Resolution:** Accept upstream's version, add back `"better-sqlite3": "^12.6.2"` to dependencies

### 11. `extensions/memory-lancedb/config.ts` — MEDIUM FRICTION
**What we add:** `hybrid` config fields
**Resolution:** Keep both sides (our hybrid + upstream's captureMaxChars)

## Conflict Resolution Strategy

1. **For HIGH FRICTION files:** Accept upstream entirely (`git checkout upstream/main -- <file>`), then surgically re-add our lines
2. **For MEDIUM/LOW FRICTION:** Use "keep both" (`<<<<<<` resolved by keeping all)
3. **README.md:** Always keep ours (`git checkout HEAD -- README.md`)
4. **pnpm-lock.yaml:** Accept upstream, then `pnpm install` to regenerate

## Post-Merge Verification

```bash
# 1. No conflict markers
grep -rn '<<<<<<< HEAD' src/ extensions/ package.json README.md 2>/dev/null | grep -v node_modules

# 2. Build passes
pnpm build 2>&1 | tail -5

# 3. Our custom fields still present
grep "triggerPrefix" src/config/zod-schema.providers-whatsapp.ts
grep "syncFullHistory" src/config/zod-schema.providers-whatsapp.ts
grep "createWhatsAppHistoryTool" src/agents/openclaw-tools.ts
grep "execSecurityLevel" src/auto-reply/types.ts
grep "thinking-reaction" src/web/auto-reply/monitor/process-message.ts
grep "markOnlineOnConnect" src/web/session.ts
grep "better-sqlite3" package.json
```

## Isolation Opportunities (Reduce Future Friction)

### Already Isolated ✅
- Thinking reaction → `src/web/auto-reply/monitor/thinking-reaction.ts`
- WhatsApp history tool → `src/agents/tools/whatsapp-history-tool.ts`
- WhatsApp history DB → `src/whatsapp-history/`

### Should Isolate Next 🔧
1. **triggerPrefix logic** → Could become an extension/hook instead of schema field
2. **syncFullHistory** → Could be a fork-local config overlay
3. **execSecurityLevel** → Could be an extension
4. **Owner media bypass** → Extract to a small helper in group-gating.ts (already somewhat isolated)

### Cannot Isolate (Minimal Injection) 📌
- `markOnlineOnConnect: true` — one line in session config
- `better-sqlite3` in package.json — required by whatsapp-history
- `sendPresenceUpdate` — one line in monitor.ts
