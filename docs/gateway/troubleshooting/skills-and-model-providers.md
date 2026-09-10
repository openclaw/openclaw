---
summary: "Skill root containment, Anthropic 429s, upstream 403s, and local OpenAI-compatible backends"
title: "Skills and model providers"
sidebarTitle: "Skills and model providers"
read_when:
  - A skill symlink is skipped as a path escape
  - Model calls fail with 429 extra-usage or upstream 403 responses
  - A local OpenAI-compatible backend passes direct probes but agent runs still fail
---

## Skill symlink skipped as path escape

Use when logs include:

```text
Skipping escaped skill path outside its configured root: ... reason=symlink-escape
```

Every skill root is a containment boundary. A symlink under `~/.agents/skills`, `<workspace>/.agents/skills`, `<workspace>/skills`, or `~/.openclaw/skills` is skipped when its real target resolves outside that root, unless the target is explicitly trusted.

Inspect the link:

```bash
ls -l ~/.agents/skills/<name>
realpath ~/.agents/skills/<name>
openclaw config get skills.load
```

If the target is intentional, configure both the direct skill root and the allowed symlink target:

```json5
{
  skills: {
    load: {
      extraDirs: ["~/path/to/skills"],
      allowSymlinkTargets: ["~/path/to/skills"],
    },
  },
}
```

Then start a new session or wait for the skills watcher to refresh. Restart the gateway if the running process predates the config change.

Do not use broad targets such as `~`, `/`, or a whole synced project folder. Keep `allowSymlinkTargets` scoped to the real skill root that contains trusted `SKILL.md` directories.

Skill Workshop does not use these trusted discovery targets. It writes only
inside the active agent's `<state-dir>/agents/<agentId>/agent/workshop-skills`.

Related:

- [Skills config](/tools/skills-config#symlinked-skill-roots)
- [Configuration examples](/gateway/configuration-examples#symlinked-sibling-skill-repo)

## Anthropic 429 extra usage required for long context

Use when logs/errors include: `HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

```bash
openclaw logs --follow
openclaw models status
openclaw config get agents.defaults.models
```

Look for:

- Selected Anthropic model is a GA-capable 1M Claude 4.x model (Opus 4.6/4.7/4.8, Sonnet 4.6), or the model config still carries legacy `params.context1m: true`.
- Current Anthropic credential is not eligible for long-context usage.
- Requests fail only on long sessions/model runs that need the 1M context path.

Fix options:

<Steps>
  <Step title="Use a standard context window">
    Switch to a standard-window model, or remove legacy `context1m` from older
    model config that is not GA-capable for 1M context.
  </Step>
  <Step title="Use an eligible credential">
    Use an Anthropic credential that is eligible for long-context requests, or switch to an Anthropic API key.
  </Step>
  <Step title="Configure fallback models">
    Configure fallback models so runs continue when Anthropic long-context requests are rejected.
  </Step>
</Steps>

Related:

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Why am I seeing HTTP 429 from Anthropic?](/help/faq-first-run#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)

## Upstream 403 blocked responses

Use when an upstream LLM provider returns a generic `403` such as `Your request was blocked`.

Do not assume this is always an OpenClaw configuration issue. The response can come from an upstream security layer such as a CDN, WAF, bot-management rule, or reverse proxy in front of an OpenAI-compatible endpoint.

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
```

Look for:

- Multiple models under the same provider failing the same way.
- HTML or generic security text instead of a normal provider API error.
- Provider-side security events for the same request time.
- A tiny direct `curl` probe succeeding while normal SDK-shaped requests fail.

Fix the provider-side filtering first when evidence points to a WAF/CDN block. Prefer a narrowly scoped allow or skip rule for the API path OpenClaw uses, and avoid disabling protection for the whole site.

<Warning>
A successful minimal `curl` does not guarantee that real SDK-style requests will pass through the same upstream security layer.
</Warning>

Related:

- [OpenAI-compatible endpoints](/gateway/config-gateway#openai-compatible-endpoints)
- [Provider configuration](/providers)
- [Logs](/logging)

## Local OpenAI-compatible backend passes direct probes but agent runs fail

Use when:

- `curl ... /v1/models` works.
- Tiny direct `/v1/chat/completions` calls work.
- OpenClaw model runs fail only on normal agent turns.

```bash
curl http://127.0.0.1:1234/v1/models
curl http://127.0.0.1:1234/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"stream":false}'
openclaw infer model run --model <provider/model> --prompt "hi" --json
openclaw logs --follow
```

Look for:

- Direct tiny calls succeed, but OpenClaw runs fail only on larger prompts.
- `model_not_found` or 404 errors even though direct `/v1/chat/completions` works with the same bare model id.
- Backend errors about `messages[].content` expecting a string.
- Intermittent `incomplete turn detected ... stopReason=stop payloads=0` warnings with an OpenAI-compatible local backend.
- Backend crashes that appear only with larger prompt-token counts or full agent runtime prompts.

<AccordionGroup>
  <Accordion title="Common signatures">
    - `model_not_found` with a local MLX/vLLM-style server: verify `baseUrl` includes `/v1`, `api` is `"openai-completions"` for `/v1/chat/completions` backends, and `models.providers.<provider>.models[].id` is the bare provider-local id. Select it with the provider prefix once, for example `mlx/mlx-community/Qwen3-30B-A3B-6bit`; keep the catalog entry as `mlx-community/Qwen3-30B-A3B-6bit`.
    - `messages[...].content: invalid type: sequence, expected a string`: backend rejects structured Chat Completions content parts. Fix: set `models.providers.<provider>.models[].compat.requiresStringContent: true`.
    - `validation.keys` or allowed message keys like `["role","content"]`: backend rejects OpenAI-style replay metadata on Chat Completions messages. Fix: set `models.providers.<provider>.models[].compat.strictMessageKeys: true`.
    - `incomplete turn detected ... stopReason=stop payloads=0`: the backend completed the Chat Completions request but returned no user-visible assistant text for that turn. OpenClaw retries replay-safe empty OpenAI-compatible turns once; persistent failures usually mean the backend is emitting empty/non-text content or suppressing final-answer text.
    - Direct tiny requests succeed, but OpenClaw agent runs fail with backend/model crashes (for example Gemma on some `llama-server` builds behind `llmman`): OpenClaw transport is likely already correct; the backend is failing on the larger agent-runtime prompt shape.
    - Failures shrink after disabling tools but do not disappear: tool schemas were part of the pressure, but the remaining issue is still upstream model/server capacity or a backend bug.

  </Accordion>
  <Accordion title="Fix options">
    1. Set `compat.requiresStringContent: true` for string-only Chat Completions backends.
    2. Set `compat.strictMessageKeys: true` for strict Chat Completions backends that only accept `role` and `content` on each message.
    3. Set `compat.supportsTools: false` for models/backends that cannot handle OpenClaw's tool schema surface reliably.
    4. Lower prompt pressure where possible: smaller workspace bootstrap, shorter session history, lighter local model, or a backend with stronger long-context support.
    5. If tiny direct requests keep passing while OpenClaw agent turns still crash inside the backend, treat it as an upstream server/model limitation and file a repro there with the accepted payload shape.
  </Accordion>
</AccordionGroup>

Related:

- [Configuration](/gateway/configuration)
- [Local models](/gateway/local-models)
- [OpenAI-compatible endpoints](/gateway/config-gateway#openai-compatible-endpoints)
