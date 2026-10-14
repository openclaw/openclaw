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

For one prompt, await `buildTtsSystemPromptHintAsync` from
`openclaw/plugin-sdk/tts-runtime`:

```ts
import { buildTtsSystemPromptHintAsync } from "openclaw/plugin-sdk/tts-runtime";

const hint = await buildTtsSystemPromptHintAsync(config, agentId, {
  messageToolOnly: true,
});
```

The result remains `string | undefined`: disabled TTS produces no hint. The
helper prepares the machine-owned preference path through the state owner and
preserves explicit configuration and `OPENCLAW_TTS_PREFS` precedence.

When a turn needs several TTS helpers, prepare once and pass the result to each
call. The synchronous overloads with required `preparedTtsPreferences` remain
supported:

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

`PreparedTtsPreferences` is a public readonly type. Treat the returned value as a
turn-scoped preparation and obtain a new one for the next turn. It retains the
selected machine path, while preference-file contents are read when each helper
runs. A committed in-process path change is visible to the next preparation.

The unprepared synchronous overloads of `resolveTtsPrefsPath` and
`buildTtsSystemPromptHint` retain their existing return values and behavior but
are deprecated. Use their awaited replacements, or supply the preparation above,
to avoid synchronous state-database reads and deprecation warnings.

## Removal timing

These adapters remain supported. Their removal date and target ordinary stable
release are **TBD**; this migration does not schedule a removal. Removal requires
the announced stable deprecation window, migration evidence, and explicit
maintainer approval described in the [compatibility policy](/plugins/compatibility)
and [removal timeline](/plugins/sdk-migration/removal-timeline).
