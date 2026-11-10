---
summary: "Awaited replacements for historical transcript-key lookup and TTS prompt preparation"
title: "Awaited transcript and TTS helpers"
read_when:
  - Migrating a plugin from synchronous transcript-key lookup
  - Preparing TTS prompts without main-thread database reads
---

## Historical transcript keys

Use `resolveTranscriptSessionKeyBySessionIdAsync` from
`openclaw/plugin-sdk/session-store-runtime` to find the session key that owns an
exact transcript identity:

```ts
import { resolveTranscriptSessionKeyBySessionIdAsync } from "openclaw/plugin-sdk/session-store-runtime";

const sessionKey = await resolveTranscriptSessionKeyBySessionIdAsync({
  agentId,
  sessionId,
  storePath,
});
```

It returns `Promise<string | undefined>` and accepts the same `agentId`, `env`,
`sessionId`, and `storePath` fields as the synchronous helper. Pass `storePath`
when the transcript belongs to a configured or shared store. An absent database
or unknown identity returns `undefined` without creating a database.

The lookup includes retained historical transcript windows after the current
session has reset to a new identity. `getSessionEntryByIdAsync` reads current
session entries and is not a substitute for this historical lookup. The helper
resolves ownership; callers still enforce their existing authorization before
disclosing transcript contents.

The synchronous `resolveTranscriptSessionKeyBySessionId` remains available as a
deprecated adapter. Calls emit a bounded warning directing authors to the
awaited replacement.

## TTS prompts

For one prompt, await the public `api.runtime.tts.buildSystemPromptHintAsync`
method. Older hosts may lack this additive capability; report an upgrade
requirement rather than falling back to a synchronous database read:

```ts
const prepareHint = api.runtime.tts.buildSystemPromptHintAsync;
if (!prepareHint) {
  throw new Error("Update OpenClaw to use async TTS prompt preparation.");
}

const hint = await prepareHint(config, agentId, {
  messageToolOnly: true,
});
```

The result remains `string | undefined`: disabled TTS produces no hint. The
helper prepares the machine-owned preference path through the state owner and
preserves explicit configuration and `OPENCLAW_TTS_PREFS` precedence.

The `openclaw/plugin-sdk/tts-runtime` subpath is private to bundled plugins.
Bundled code that needs several TTS helpers in one turn can prepare once and
pass the result to each call. Its synchronous overloads with required
`preparedTtsPreferences` remain supported:

```ts
import {
  buildTtsSystemPromptHint,
  prepareTtsPreferences,
  resolveTtsConfig,
  resolveTtsPrefsPath,
} from "openclaw/plugin-sdk/tts-runtime";

const preparedTtsPreferences = await prepareTtsPreferences();
const prefsPath = resolveTtsPrefsPath(resolveTtsConfig(config, agentId), preparedTtsPreferences);
const hint = buildTtsSystemPromptHint(config, agentId, {
  messageToolOnly: true,
  preparedTtsPreferences,
});
```

`PreparedTtsPreferences` is a private readonly type. Treat the returned value as a
turn-scoped preparation and obtain a new one for the next turn. It retains the
selected machine path, while preference-file contents are read when each helper
runs. A committed in-process path change is visible to the next preparation.

The unprepared synchronous overloads of `resolveTtsPrefsPath` and
`buildTtsSystemPromptHint` retain their existing return values and behavior but
are deprecated. Use their awaited replacements, or supply the preparation above,
to avoid synchronous state-database reads and deprecation warnings.

## Removal timing

These deprecated adapters remain supported through **2026-12-31**, the final
compatibility day. Removal ships in the **first January 2027 stable release**,
without a Plugin SDK major version. The prepared SQL-free TTS overloads remain
supported. See the [complete SQLite migration guide](/plugins/sdk-migration/sqlite-async)
and [removal timeline](/plugins/sdk-migration/removal-timeline).
