---
summary: "Per-tool settings for exec, loop detection, web search and fetch, media understanding, and the plan tool"
read_when:
  - Tuning `exec` timeouts, approvals, or `apply_patch`
  - Configuring web search, web fetch, or inbound media understanding
  - Turning tool-loop detection or `progress_card` on or off
title: "Configuration — built-in tool settings"
---

Settings for individual built-in tools. Whether a run may call them at all is decided by [tool policy](/gateway/config-tools/tool-policy).

## `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSeconds: 1800,
      cleanupMs: 1800000,
      approvalRunningNoticeMs: 10000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      commandHighlighting: false,
      applyPatch: {
        enabled: true,
        allowModels: ["gpt-5.6-sol"],
      },
    },
  },
}
```

Values shown are defaults except `applyPatch.allowModels` (empty/unset by default, meaning any compatible model may use `apply_patch`). `approvalRunningNoticeMs` emits a running notice when approval-backed exec runs long; `0` disables it.

`tools.exec.grantExpiryDays` (unset by default) sets the default lifetime, in days (1–3650), for standing grants minted by Always allow on automation approvals. Unset keeps grants valid until revoked or the owning automation changes. Terms freeze at mint, so changing the value affects only future grants; see [Standing grants for automations](/tools/exec-approvals#standing-grants-for-automations).

## `tools.loopDetection`

Tool-loop safety checks are **disabled by default**. Set `enabled: true` to activate detection. Settings can be defined globally in `tools.loopDetection` and overridden per-agent at `agents.entries.*.tools.loopDetection`.

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
    },
  },
}
```

## `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave", // optional; omit for auto-detect
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
      fetch: {
        enabled: true,
        provider: "firecrawl", // optional; omit for auto-detect
        maxChars: 20000,
        maxCharsCap: 20000,
        maxResponseBytes: 750000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        readability: true,
        userAgent: "custom-ua",
      },
    },
  },
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: { apiKey: "brave_api_key" }, // or BRAVE_API_KEY env
        },
      },
    },
  },
}
```

Web-search provider credentials belong under `plugins.entries.<plugin>.config.webSearch`, as shown for Brave; see [Web search](/tools/web#storing-api-keys). The `tools.web` values shown are defaults except `provider` and `userAgent`. `maxResponseBytes` clamps to 32000–10000000; `maxChars` clamps to `maxCharsCap` (raise `maxCharsCap` to allow larger responses).

## `tools.media`

Configures inbound media understanding (image/audio/video):

```json5
{
  tools: {
    media: {
      concurrency: 2,
      models: [
        { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] },
        {
          type: "cli",
          command: "whisper",
          args: ["--model", "base", "{{AttachmentPath}}"],
          capabilities: ["audio"],
        },
        { provider: "ollama", model: "gemma4:26b", capabilities: ["image"] },
        { provider: "google", model: "gemini-3-flash-preview", capabilities: ["video"] },
      ],
      audio: { enabled: true, preferredModel: "openai/gpt-4o-mini-transcribe" },
      image: { enabled: true, preferredModel: "ollama/gemma4:26b" },
      video: { enabled: true },
    },
  },
}
```

`tools.media.models` is the only configured model list. Every entry declares the capabilities it handles. The optional `preferredModel` selector accepts `provider/model`, a model id, `provider:<id>` for provider-default entries, or `cli:command`; matching entries move to the front of that capability's fallback order. Per-capability prompts, limits, request settings, scope, attachment policy, and audio transcript echo remain defaults for configured and auto-detected models; a model entry can override model-specific fields.

<AccordionGroup>
  <Accordion title="Media model entry fields">
    **Provider entry** (`type: "provider"` or omitted):

    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc.)
    - `model`: model id override
    - `profile` / `preferredProfile`: stored auth-profile selection

    **CLI entry** (`type: "cli"`):

    - `command`: executable to run
    - `args`: templated args (supports `{{AttachmentPath}}`, `{{AttachmentUrl}}`, `{{AttachmentContentType}}`, `{{AttachmentDir}}`, `{{AttachmentIndex}}`, `{{Prompt}}`, `{{MaxChars}}`, etc.; `openclaw doctor --fix` migrates deprecated `{input}` placeholders to `{{AttachmentPath}}`). The older `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`, and `{{MediaDir}}` aliases remain available during their compatibility window but are deprecated.

    **Common fields:**

    - `capabilities`: list containing one or more of `image`, `audio`, and `video`.
    - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: per-entry overrides.
    - Matching image model `timeoutSeconds` entries also apply when the agent calls the explicit `view_image` tool. For image understanding, this timeout applies to the request itself and is not reduced by earlier preparation work.
    - Failures fall back to the next entry.

    Provider auth follows standard order: SQLite auth profiles → env vars → `models.providers.*.apiKey`.

  </Accordion>
</AccordionGroup>

<a id="toolsupdateplan"></a>

## `tools.updatePlan`

Kill switch for `progress_card`, the durable plan and status note used for non-trivial multi-step work tracking.

```json5
{
  tools: {
    updatePlan: false, // hide progress_card from every run
  },
}
```

- Default: `true` for every provider and model. Set `false` to keep the tool off; there is no model-specific auto-enable rule.
- The tool description tells the model to keep the plan current, use at most one `in_progress` step, and add Markdown only when it contributes information beyond the steps.
- Use `progress_card` in new `tools.allow` and `tools.deny` policies. Existing policies that name `update_plan` map to `progress_card`, so shipped allowlists and denylists keep their meaning.

Older configs used `tools.experimental.planTool`. Run `openclaw doctor --fix` to move the value to `tools.updatePlan`.
