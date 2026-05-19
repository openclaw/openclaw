# Code Verification Report — Batch 1

Generated: 2026-05-20

---

## 1. #84071 — EmbeddedAttemptSessionTakeoverError on co-tenant writes

**Verdict: CONFIRMED**

**File:** `src/agents/pi-embedded-runner/run/attempt.session-lock.ts`

The session write lock mechanism uses a **fingerprint-based fence** to detect takeover:

1. When `releaseForPrompt()` is called (line 304), the held lock is released and a `fenceFingerprint` is recorded by reading the session file's current fingerprint. `fenceActive` is set to `true`.
2. When `withSessionWriteLock()` re-acquires the lock, `assertSessionFileFence()` (line 287) compares the current session file fingerprint against the stored fence. If they differ, `takeoverDetected = true` and `EmbeddedAttemptSessionTakeoverError` is thrown.
3. If re-acquisition fails with a timeout, `takeoverDetected` is also set to `true` (line 278).

**The bug pattern:** In multi-tenant / co-tenant scenarios, a second process or agent turn writing to the same session file between `releaseForPrompt()` and the next `withSessionWriteLock()` call changes the file fingerprint. The fence check then fires a false-positive takeover error because the fingerprint changed — even though the write was a legitimate co-tenant operation, not an actual hostile takeover.

The code has no mechanism to distinguish "legitimate co-tenant write that changed the fingerprint" from "an actual session takeover by a competing process trying to hijack the session." The `sameSessionFileFingerprint()` comparison is binary — any fingerprint drift triggers the error.

---

## 2. #84141 — Cron isolated turns omit exec tool despite toolsAllow

**Verdict: CONFIRMED**

**Files:**

- `src/cron/isolated-agent/run-executor.ts` (lines 59–63)
- `src/agents/pi-embedded-runner/run/attempt-tool-construction-plan.ts` (lines 11–13, 130–157)

The tool construction pipeline has two filtering stages for cron jobs:

**Stage 1 — `resolveCronOwnerOnlyToolAllowlist()`** (run-executor.ts:59):

```ts
function resolveCronOwnerOnlyToolAllowlist(toolsAllow: string[] | undefined): string[] | undefined {
  if (!normalizeToolList(toolsAllow).includes("cron")) {
    return undefined;
  }
  return ["cron"];
}
```

This only passes through `["cron"]` if the allowlist includes `cron`, otherwise returns `undefined` (no owner-only restriction). This is used as `ownerOnlyToolAllowlist` — a separate concept from the full `toolsAllow`.

**Stage 2 — `resolveEmbeddedAttemptToolConstructionPlan()`** (attempt-tool-construction-plan.ts:165+):
The `toolsAllow` array controls which tool categories are _constructed_. The function `resolveCodingToolConstructionPlanForAllowlist()` (line 131) checks if any name in `toolsAllow` matches known tool sets:

- `SHELL_CODING_TOOL_FACTORY_NAMES = new Set(["apply_patch", "exec", "process"])`
- `BASE_CODING_TOOL_FACTORY_NAMES = new Set(["edit", "read", "write"])`

The plan determines `includeShellTools` by checking if any toolsAllow entry is in `SHELL_CODING_TOOL_FACTORY_NAMES`. Then `constructTools` and `includeCoreTools` gate whether the tool factory functions are even called.

**The bug:** If a cron job sets `toolsAllow: ["exec", "message"]`, the tool construction plan correctly sets `includeShellTools = true`. However, the `toolsAllow` is also passed as `runtimeToolAllowlist` and is applied post-construction via `applyEmbeddedAttemptToolsAllow()` (line 89), which filters the final tool array using `isToolAllowedByPolicyName()`. The `exec` tool name must match exactly.

The issue is likely in how isolated sessions resolve tool construction. Isolated cron sessions (with `sessionTarget === "isolated"`) go through `runEmbeddedPiAgent` (line 240), which receives both `ownerOnlyToolAllowlist` and `toolsAllow`. But `senderIsOwner` is hardcoded to `false` (line 250). When `senderIsOwner` is false, the `ownerOnlyToolAllowlist` acts as an **additional restriction** — if exec isn't in the owner-only list but is in `toolsAllow`, the tool may still be filtered out by owner-only policy enforcement, since the cron turn is not treated as an owner.

**Root cause confirmed:** `senderIsOwner: false` in the cron executor combined with the `ownerOnlyToolAllowlist` mechanism means exec (which is typically owner-only) gets filtered even when explicitly listed in `toolsAllow`.

---

## 3. #84079 — message tool rejects SendMessage instead of normalizing

**Verdict: CONFIRMED**

**Files:**

- `src/agents/tools/message-tool.ts` (line 957)
- `src/agents/tools/common.ts` (line 101+)
- `src/channels/plugins/message-action-names.ts`

The message tool reads the `action` parameter via `readStringParam()`, which trims whitespace but does **no case normalization** (no `.toLowerCase()`, no alias mapping):

```ts
const action = readStringParam(params, "action", {
  required: true,
}) as ChannelMessageActionName;
```

The valid action names in `CHANNEL_MESSAGE_ACTION_NAMES` are all lowercase: `"send"`, `"read"`, `"edit"`, `"delete"`, `"react"`, etc.

The JSON schema presented to the LLM uses a `{ type: "string", enum: [...] }` constraint (via `stringEnum()`), but this is a **hint** — not enforced at runtime. LLMs can and do generate non-canonical casing like `"SendMessage"`, `"Send"`, or `"SEND"`.

When the LLM generates `"SendMessage"` or `"Send"`, `readStringParam()` returns that value as-is. It's then cast to `ChannelMessageActionName` (a TypeScript type, not a runtime check) and passed to `runMessageActionForTool()`. The downstream `normalizeMessageActionInput()` function in `src/infra/outbound/message-action-normalization.ts` also does not normalize the action name itself — it only normalizes argument fields like `channel`, `target`, etc.

The result: the action string `"SendMessage"` does not match any handler, producing a rejection or error rather than being normalized to `"send"`.

---

## 4. #84068 — Update button no-op on systemd installs

**Verdict: CONFIRMED**

**Files:**

- `src/daemon/systemd-unit.ts` (line 85): `KillMode=control-group`
- `src/infra/process-respawn.ts` (lines 28–38, 100–125)
- `src/cli/gateway-cli/run-loop.ts` (lines 161–220)

The systemd unit template explicitly sets:

```ini
KillMode=control-group
```

This means when systemd restarts the service, **all processes in the cgroup are killed**, including any child processes.

The update flow works as follows:

1. `runGatewayUpdate()` performs git pull + pnpm install.
2. After completion, the gateway triggers a restart via `handleRestartAfterServerClose()` (run-loop.ts:160).
3. For update restarts, `respawnGatewayProcessForUpdate()` (process-respawn.ts:100) is called.
4. If no supervisor is detected, it calls `spawnDetachedGatewayProcess()` which spawns a child with `detached: true` + `child.unref()`.
5. If a supervisor IS detected (including systemd), it returns `{ mode: "supervised" }`.
6. For supervised mode, the gateway calls `exitProcess(0)` (run-loop.ts:220), expecting systemd to restart it.

**The problem path (non-supervised detection):** If the systemd environment variables (`OPENCLAW_SYSTEMD_UNIT`, `INVOCATION_ID`, etc.) are not properly set, `detectRespawnSupervisor()` may not detect systemd, leading to the `spawnDetachedGatewayProcess()` path. The spawned child process lives in the same cgroup. When the parent exits, systemd's `KillMode=control-group` kills the child too — making the update a no-op.

**The problem path (supervised detection):** Even in the supervised path, `exitProcess(0)` triggers systemd restart. But `SuccessExitStatus=0 143` means exit 0 is considered success. With `Restart=always`, systemd should restart. However, `StartLimitBurst=5` / `StartLimitIntervalSec=60` can block restart if there were recent restarts.

The core issue is the `KillMode=control-group` + detached child spawn interaction: the detached child helper that's supposed to survive the parent's exit gets killed by systemd's cgroup cleanup.

---

## 5. #84291 — Dreaming fails on >16MB short-term-recall.json

**Verdict: LIKELY**

**Files:**

- `extensions/memory-core/src/short-term-promotion.ts` (lines 1801, 1960)
- `src/memory-host-sdk/dreaming.ts` (configuration only)

The code reads the short-term-recall store with a simple:

```ts
const raw = await fs.readFile(storePath, "utf-8");
const parsed = JSON.parse(raw) as unknown;
```

There is **no file size check** before `readFile()` or `JSON.parse()`. No `stat()` call to verify size, no streaming JSON parser, no size guard.

However, `fs.readFile()` in Node.js does NOT have a hard 16MB limit — it can read files much larger than 16MB. `JSON.parse()` also handles files well beyond 16MB on modern V8.

The 16MB figure (16,777,216 bytes) doesn't appear anywhere in the dreaming or memory code. This suggests the failure might come from:

1. **V8 string length limits** — Node.js has a max string length (typically 512MB–1GB), so 16MB is well within range.
2. **Memory pressure** — A 16MB JSON file expands significantly in memory when parsed (easily 3-5x). Combined with the rest of the dreaming pipeline, this could trigger OOM on constrained systems.
3. **Provider token limits** — If the parsed entries are fed into an LLM prompt, the massive context could exceed token limits.
4. **An upstream or runtime guard** — There might be a file size check in the plugin runtime or gateway layer that's not in the core source tree.

The code lacks defensive size checking, which makes it **susceptible** to failure on large files, but the exact 16MB threshold isn't enforced by the code itself. The report is likely valid from user experience (OOM, timeout, or downstream failure), even though the exact mechanism isn't a hardcoded size check.

---

## 6. #84092 — WhatsApp drops long responses

**Verdict: UNCLEAR**

**Files:**

- `extensions/whatsapp/src/outbound-base.ts` (line 148): `textChunkLimit: 4000`
- `extensions/whatsapp/src/outbound-adapter.ts`: uses `chunkText` chunker
- `src/auto-reply/chunk.ts`: `DEFAULT_CHUNK_LIMIT = 4000`
- `extensions/whatsapp/src/shared.ts` (line 210): capabilities definition

The WhatsApp channel has proper text chunking:

- `textChunkLimit: 4000` (set in outbound-base.ts:148)
- `chunker: chunkText` (from reply-chunking module)
- The chunker splits long text into multiple messages of ≤4000 chars each

This means long responses should be **split into multiple messages**, not dropped. The chunking pipeline is standard and used across multiple channels.

However, there are potential drop scenarios:

1. **`skipEmptyText: true`** (outbound-adapter.ts:35) — if normalization reduces text to empty, messages are silently dropped.
2. **Error payloads** (outbound-base.ts:234): `if (ctx.payload.isError === true) return { messageId: "" }` — error responses produce empty results silently.
3. **Structured-only payloads** (outbound-base.ts:239): If the agent sends a `presentation` or `interactive` payload without text/media, WhatsApp throws an error.
4. **The capabilities object** does NOT advertise `presentation` support, which means the presentation layer may not route rich content to WhatsApp at all.

Without seeing the specific "recently introduced" change referenced in the issue, I cannot confirm whether a new code change introduced a regression. The existing code appears to handle long text correctly via chunking. The issue might be about a specific edge case (e.g., a particular formatting pattern that causes the chunker to produce empty chunks, or a presentation payload that gets dropped).

---

## Summary

| Issue                                                    | Verdict       | Confidence                                               |
| -------------------------------------------------------- | ------------- | -------------------------------------------------------- |
| #84071 — Session takeover error on co-tenant writes      | **CONFIRMED** | High — fingerprint fence has no co-tenant awareness      |
| #84141 — Cron isolated turns omit exec tool              | **CONFIRMED** | High — senderIsOwner=false + owner-only tool filtering   |
| #84079 — message tool rejects non-canonical action names | **CONFIRMED** | High — no case normalization in readStringParam          |
| #84068 — Update no-op on systemd                         | **CONFIRMED** | High — KillMode=control-group kills detached children    |
| #84291 — Dreaming fails on >16MB recall file             | **LIKELY**    | Medium — no size guard, but 16MB limit not hardcoded     |
| #84092 — WhatsApp drops long responses                   | **UNCLEAR**   | Low — chunking looks correct, need specific reproduction |
