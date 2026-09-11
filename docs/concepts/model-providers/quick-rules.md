---
summary: "Model refs, CLI helpers, the primary-model preservation rule, and the OpenAI provider/runtime split."
read_when:
  - You need the model-ref and CLI-helper basics
  - You are adding provider auth and want to keep your primary model
  - You need the OpenAI provider/runtime or CLI-runtime split
title: "Quick rules"
---

## Quick rules

<AccordionGroup>
  <Accordion title="Model refs and CLI helpers">
    - Model refs use `provider/model` (example: `opencode/claude-opus-4-6`).
    - `agents.defaults.models` stores aliases and per-model settings; `agents.defaults.modelPolicy.allow` is the optional explicit override allowlist.
    - CLI helpers: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.
    - `models.providers.*.maxTokens` sets the provider-level output-token default. On each `models.providers.*.models[]` entry, `contextWindow` declares the native window, `contextTokens` caps active input, and `maxTokens` overrides output capacity for that model. Configured output limits are clamped to the final native context window when known: the per-model `contextWindow`, otherwise the discovered window.
    - Fallback rules, cooldown probes, and session-override persistence: [Model failover](/concepts/model-failover).

  </Accordion>
  <Accordion title="Adding provider auth does not change your primary model">
    `openclaw configure` preserves an existing `agents.defaults.model.primary` when you add or reauth a provider. `openclaw models auth login` does the same unless you pass `--set-default`. Provider plugins may still return a recommended default model in their auth config patch, but OpenClaw treats that as "make this model available" when a primary model already exists, not "replace the current primary model."

    To intentionally switch the default model, use `openclaw models set <provider/model>` or `openclaw models auth login --provider <id> --set-default`.

  </Accordion>
  <Accordion title="OpenAI provider/runtime split">
    OpenAI model refs and agent runtimes are separate:

    - `openai/<model>` selects the canonical OpenAI provider and model. The prefix alone never selects Codex.
    - With provider/model runtime policy unset or `auto`, OpenAI may select Codex implicitly only for an exact official HTTPS Platform Responses or ChatGPT Responses route with no authored provider request override. Valid model-scoped Fast-mode controls do not count as authored request params.
    - Authored Completions adapters, custom endpoints, and routes with authored request behavior stay on OpenClaw. Plaintext official HTTP endpoints are rejected.
    - legacy Codex model refs are legacy config that doctor rewrites to `openai/<model>`.
    - Provider/model `agentRuntime.id: "openclaw"` explicitly keeps an otherwise eligible route on OpenClaw. `agentRuntime.id: "codex"` requires Codex and fails closed when the effective route is not Codex-compatible.

    See [OpenAI implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime) and [Codex harness](/plugins/codex-harness). If the provider/runtime split is confusing, read [Agent runtimes](/concepts/agent-runtimes) first.

    Plugin auto-enable follows the same boundary: an implicitly Codex-compatible effective route can enable the Codex plugin, while explicit provider/model `agentRuntime.id: "codex"` or legacy `codex/<model>` refs require it. An `openai/*` prefix by itself does not.

    Fresh OpenAI API-key and ChatGPT/Codex OAuth setup select the canonical
    `openai/gpt-5.6-sol` ref. The bare direct-API `openai/gpt-5.6` alias remains
    supported and resolves to Sol. Existing explicit primaries, including
    `openai/gpt-5.5`, are preserved when OpenAI auth is added or refreshed. GPT-5.5 remains available
    through either runtime as an explicit recovery choice for accounts without
    GPT-5.6 access.

  </Accordion>
  <Accordion title="CLI runtimes">
    CLI runtimes use the same split: choose canonical model refs such as `anthropic/claude-*` or `google/gemini-*`, then set provider/model runtime policy to `claude-cli` or `google-gemini-cli` when you want a local CLI backend.

    Legacy `claude-cli/*` and `google-gemini-cli/*` refs migrate back to canonical provider refs with the runtime recorded separately. Legacy `codex-cli/*` refs migrate to `openai/*` and use the Codex app-server route; OpenClaw no longer keeps a bundled Codex CLI backend.

  </Accordion>
</AccordionGroup>
