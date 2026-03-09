---
title: "TTS for Agents"
description: "How to write messages that work for both text chat and voice output"
---

# Writing Dual-Purpose Messages (Text + Voice)

OpenClaw's TTS pipeline lets agents send a single message that serves **both** text (chat) and voice (spoken audio). The user's preference determines delivery — the agent doesn't choose.

This means every message must read well on screen **and** sound natural when spoken aloud. The challenge: code blocks, tables, and type signatures are useful to read but painful to hear.

## The Multi-Layered Approach

Three mechanisms work together to produce clean voice output from a rich text message:

1. **Auto-stripping** — fenced code blocks and markdown tables are automatically removed from the spoken version.
2. **`<tts>` tags** — inline spoken alternatives for technical content that would sound awkward.
3. **`[[tts:text]]` directives** — full override of the spoken text (takes priority over everything else).

The visible chat message always shows the full content with `<tts>` tags removed.

## `<tts>` Tags

Wrap spoken alternatives in `<tts>...</tts>`. The content inside is **spoken in voice** but **hidden in chat**. The content outside (adjacent code, types, etc.) remains **visible in chat** but gets stripped or left as-is in voice.

### Syntax

```
<tts>spoken alternative</tts>
```

### How It Works

| Surface             | `<tts>` content  | Adjacent code/tables            |
| ------------------- | ---------------- | ------------------------------- |
| Chat (visible text) | Removed entirely | Shown normally                  |
| Voice (spoken text) | Spoken aloud     | Code fences and tables stripped |

### Example: Inline Type Reference

**Agent writes:**

```
The function returns <tts>a list of user objects</tts>`User[]`.
```

**Chat sees:**

> The function returns `User[]`.

**Voice hears:**

> "The function returns a list of user objects User array."

### Example: Code Block with Spoken Summary

**Agent writes:**

````
Here's how to connect:
<tts>Call the connect function with your host and port.</tts>

​```typescript
await connect({ host: "localhost", port: 8080 });
​```
````

**Chat sees:**

> Here's how to connect:
>
> ```typescript
> await connect({ host: "localhost", port: 8080 });
> ```

**Voice hears:**

> "Here's how to connect. Call the connect function with your host and port."

### Example: Table with Spoken Summary

**Agent writes:**

```
Here are the results:
<tts>Alice scored 95 and Bob scored 87. Alice won.</tts>

| Name  | Score |
|-------|-------|
| Alice | 95    |
| Bob   | 87    |

Summary: Alice won.
```

**Chat sees** the full table. **Voice hears** the spoken summary plus "Summary: Alice won."

## Auto-Stripping Rules

These are removed from spoken text automatically (no tags needed):

- **Fenced code blocks** — lines between ` ``` ` pairs (with or without a language tag)
- **Markdown tables** — lines that start and end with `|`

These are **not** stripped:

- Inline backticks (`` `code` ``) — kept in spoken text
- Lines with `|` that don't both start and end with `|` (shell pipes, OR operators)

## Best Practices

**Place `<tts>` tags to replace, not duplicate.** The spoken alternative should cover what the adjacent technical content conveys. Don't repeat the same information in both.

````
<!-- Good: <tts> replaces the code block's meaning -->
<tts>Define a greeting function that takes a name parameter.</tts>
​```python
def greet(name: str):
    return f"Hello, {name}"
​```

<!-- Bad: redundant — says the same thing twice in voice -->
Here's a greeting function.
<tts>Here's a greeting function.</tts>
​```python
def greet(name: str):
    return f"Hello, {name}"
​```
````

**Keep `<tts>` content natural.** Write it as you'd say it out loud. Avoid markdown formatting inside `<tts>` tags.

**Don't over-tag.** Simple prose doesn't need `<tts>` tags — it already sounds fine spoken. Use tags only when the visible text contains something that would sound bad in speech (code, symbols, tables).

**Multiline is fine.** `<tts>` content can span multiple lines.

## `[[tts:text]]` Directives

For full control over spoken output, use the `[[tts:text]]` block directive. When present, it **overrides** all other processing — the entire spoken text comes from this directive.

```
[[tts:text]]
This is exactly what gets spoken, word for word.
[[/tts:text]]

Everything else in this message is for chat display only.
```

Directives are processed **before** `<tts>` tags in the pipeline, so they take priority. Use them when the spoken version needs to be completely different from the visible message (rare).

## Configuration

The preprocessing behavior is controlled by three options in `TtsPreprocessOptions`:

| Option            | Default | Effect                                                     |
| ----------------- | ------- | ---------------------------------------------------------- |
| `stripCodeBlocks` | `true`  | Remove fenced code blocks from spoken text                 |
| `stripTables`     | `true`  | Remove markdown table lines from spoken text               |
| `processTtsTags`  | `true`  | Process `<tts>` tags (spoken alt in voice, hidden in chat) |

These are set in the TTS configuration. Most setups should leave all three enabled.

## The `tts-filter.sh` Script

`scripts/tts-filter.sh` is a standalone shell implementation of the same filtering logic. It takes a message string and produces both outputs:

```bash
./scripts/tts-filter.sh "Your message with <tts>spoken alt</tts> and \`\`\`code\`\`\`"
```

**Output:**

- `---TEXT---` section: the chat-visible text (tags stripped)
- `---VOICE---` section: path to generated voice audio file (code/tables stripped, tags unwrapped)

The script uses `perl` for regex processing and calls `sag` (ElevenLabs CLI) + `ffmpeg` for audio generation. It's useful for testing how a message will split, or for external tooling that needs the same filtering outside the Node runtime.

## Integration with `preprocessTtsText`

The TypeScript implementation lives in `src/tts/tts-core.ts`. It returns two strings:

- `visibleText` — for chat display (tags removed, everything else preserved)
- `spokenText` — for TTS synthesis (code/tables stripped, tag content kept)

The pipeline order is:

1. `parseTtsDirectives()` — extracts `[[tts:...]]` directives, returns `cleanedText`
2. `preprocessTtsText()` — processes `<tts>` tags and strips code/tables from the cleaned text
3. If a `ttsText` directive was found in step 1, it overrides the `spokenText` from step 2

This means `[[tts:text]]` directives inside `<tts>` tags are still processed (they're extracted before the tags are handled).
