---
doc_id: rbk_openclaw_local_first_model_stack
title: OpenClaw local-first model stack
type: ops_sop
lifecycle_state: active
owners:
  primary: platform
tags:
  - openclaw
  - local-first-privacy
  - ollama
  - llama.cpp
  - routing
  - model-selection
  - cloud-fallback
aliases:
  - local model recommendation
  - I want to run a local model
  - llama.cpp local stack
  - llama.cpp
  - Ollama fallback stack
  - native Ollama
  - local fallback order
scope:
  service: openclaw-gateway
  feature: local-first-model-stack
  plugin: local-first-privacy
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: "openclaw-safe-install/README.md and openclaw-safe-install/LOCAL-FIRST-MODEL-STACK.md"
retrieval:
  synopsis: "How the OpenClaw gateway keeps ordinary work on native Ollama, which local models are preferred, and how the privacy plugin and policy validate the local fallback path."
  hints:
    - local model recommendation
    - llama.cpp
    - Ollama
    - native Ollama
    - local fallback order
    - ollama/qwen3.5:9b-q4_K_M
    - ollama/gemma3:12b
    - LOCAL_FIRST_PROFILE
    - LOCAL_FIRST_PLUGIN_PATH
    - LOCAL_FIRST_POLICY_FILE
  not_for:
    - openai oauth login order
    - chatgpt subscription recovery
    - systemd hardening
  commands:
    - LOCAL_FIRST_PLUGIN_PATH=/var/lib/openclaw/.openclaw/extensions/local-first-privacy/index.js LOCAL_FIRST_POLICY_FILE=/var/lib/openclaw/.openclaw/policies/local-first-routing.json node /home/ebatter1/Documents/openclaw-safe-install/staging/validate-local-first-stack.mjs
    - systemctl --user -M openclaw@ restart openclaw-gateway.service
---

# Purpose

Record the local-first stack that keeps ordinary work on native Ollama, applies deterministic privacy scanning/redaction, and falls back to `openai-codex/*` only when cloud escalation is allowed.

# Aliases

- `local model recommendation`
- `llama.cpp local stack`
- `Ollama fallback stack`
- `cloud/local routing`
- `openai-codex models`

# When to use

- A routing audit asks which local models are preferred before cloud escalation.
- A turn should stay local but is being routed to a cloud primary anyway.
- The operator needs the current local fallback order for main, coding, review, code-security, or high-risk paths.
- The privacy plugin or policy file needs to be revalidated after a change.

# Prerequisites

- The live gateway is running as `openclaw-gateway.service` under the `openclaw` user.
- The local-first plugin and policy file are present in the live deployment.
- Native Ollama is available for the local inference path.
- Local model selection is intentional, not accidental, when `LOCAL_FIRST_PROFILE` is set.

# Signals / symptoms

- `router` and `security_redaction` should remain local-only.
- `main`, `coding`, `review`, `code_security`, and `high_risk_escalation` should use their cloud primary first, with local fallback preserved.
- The preferred local fallback on the live stack is `ollama/qwen3.5:9b-q4_K_M`.
- `gemma3:12b` remains the first local option for review and security-redaction style work.
- Cloud-bound turns should emit the privacy audit sequence described in `LOCAL-FIRST-MODEL-STACK.md`.

# Triage

1. Confirm the live policy and plugin paths still point at the staged local-first copies.
2. Check whether the current host profile is `gpu_12gb` or `cpu_only`.
3. Compare the active routing behavior with the documented order in `LOCAL-FIRST-MODEL-STACK.md`.
4. If the live stack drifted, re-run the staged validation and restart the user gateway.

# Mitigation

Use the documented local-first routing, not ad hoc model switching:

- Keep the main OpenClaw loop on native Ollama.
- Preserve `ollama/qwen3.5:9b-q4_K_M` as the main local fallback.
- Preserve `ollama/gemma3:12b` as the first local option for review and security-redaction.
- Keep cloud-primary roles on `openai-codex/*` only where the policy allows escalation.
- Treat API-key `openai/*` as a separate, staged fallback path for Signal STT only when explicitly enabled.

# Validation

Run the live-plugin/live-policy harness:

```bash
LOCAL_FIRST_PLUGIN_PATH=/var/lib/openclaw/.openclaw/extensions/local-first-privacy/index.js \
LOCAL_FIRST_POLICY_FILE=/var/lib/openclaw/.openclaw/policies/local-first-routing.json \
node /home/ebatter1/Documents/openclaw-safe-install/staging/validate-local-first-stack.mjs
```

Then confirm the gateway restarts cleanly:

```bash
systemctl --user -M openclaw@ restart openclaw-gateway.service
```

# Rollback

If the live stack no longer matches the documented routing, reapply the staged local-first config and refresh the gateway from the safe-install tree, then restart the user service.

# Related runbooks

- `/home/ebatter1/Documents/openclaw-safe-install/LOCAL-FIRST-MODEL-STACK.md`
- `/home/ebatter1/Documents/openclaw-safe-install/README.md`
- `/home/ebatter1/Documents/OPENCLAW-CODEX-ON-DEMAND.md`

# Change history

- 2026-04-22: Created a focused runbook for the local-first Ollama stack, cloud fallback order, and validation harness.
