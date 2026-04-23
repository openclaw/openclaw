---
doc_id: rbk_openai_oauth_cloud_routing
title: OpenAI OAuth cloud routing
type: ops_sop
lifecycle_state: active
owners:
  primary: platform
tags:
  - openai-codex
  - oauth
  - chatgpt-subscription
  - cloud-routing
  - quota-recovery
aliases:
  - ChatGPT subscription OAuth
  - use my oauth for my chatgpt subscription
  - openai models available to me via oauth
  - openai-codex routing
  - openai-codex/* fallback order
  - openai-codex auth order
  - subscription fallback order
scope:
  service: openclaw-gateway
  feature: openai-oauth-routing
  plugin: ""
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: "openclaw-safe-install/README.md and openclaw-safe-install/LOCAL-FIRST-MODEL-STACK.md"
retrieval:
  synopsis: "How the gateway selects `openai-codex/*` OAuth models for cloud-primary work, the live auth order, and how to clear a per-session `authProfileOverride` that pins the wrong subscription."
  hints:
    - openai oauth models
    - ChatGPT subscription
    - openai-codex/*
    - openai-codex:default
    - openai-codex:openai-alt
    - openai-codex:openai-main
    - authProfileOverride
    - openai-codex auth order
    - subscription fallback order
  not_for:
    - local Ollama fallback tuning
    - local-first privacy plugin redaction
  commands:
    - systemctl --user -M openclaw@ restart openclaw-gateway.service
---

# Purpose

Record the cloud-primary routing path that uses ChatGPT/Codex subscription OAuth via `openai-codex`, along with the live auth order and the per-session override caveat that can pin a chat to the wrong subscription.

# Aliases

- `ChatGPT subscription OAuth`
- `openai-codex routing`
- `openai-codex/* fallback order`
- `cloud/local routing override`
- `subscription fallback order`

# When to use

- A cloud-primary role should be using `openai-codex/*`, but the chat keeps retrying the wrong subscription.
- A rate-limit event does not advance the chat to the next profile.
- A session appears stuck on an exhausted profile after reauthentication.
- You need the documented live order for the `openai-codex` auth store.

# Prerequisites

- The live gateway is running under the `openclaw` user.
- The `openai-codex` provider is authenticated for the active subscription profiles.
- You can inspect the active session state for a per-chat `authProfileOverride`.

# Signals / symptoms

- Current live auth order should be `openai-codex:default -> openai-codex:openai-alt -> openai-codex:openai-main`.
- The active `ebatter1@gmail.com` path is the primary profile.
- `archergriswold@gmail.com` is the first fallback profile.
- A chat can remain pinned by a session-level `authProfileOverride` even when the provider auth order is correct.
- The live runtime only auto-clears that override on `auth_permanent`, not on `rate_limit`.

# Triage

1. Confirm the live `openai-codex` auth order matches the documented primary and fallback profiles.
2. Check the stuck chat for a session-level `authProfileOverride`.
3. Decide whether the session needs the override advanced or cleared before the next cloud turn.
4. If the wrong provider still wins, reauth the named profile and verify the stored order again.

# Mitigation

Use the documented OAuth order and keep the per-chat override in view:

- Keep `openai-codex:default` first.
- Keep `openai-codex:openai-alt` as the first backup profile.
- Keep `openai-codex:openai-main` as the last profile in the live order.
- Refresh the named profile when tokens expire or are reissued.
- Clear or advance the session override when one chat is pinned to an exhausted subscription.
- Leave `openai/*` API-key models out of normal chat and coding routing; they were tested and rolled back.

# Validation

- Confirm the live auth order still reads `openai-codex:default -> openai-codex:openai-alt -> openai-codex:openai-main`.
- Confirm the stuck session no longer carries the wrong `authProfileOverride`.
- Confirm cloud-primary roles can reach the intended Codex subscription path after reauth.

# Rollback

If the cloud path is misbehaving, reauthenticate the active `openai-codex` profile set, restore the documented auth order, and clear any stale per-chat override that keeps the wrong subscription pinned.

# Related runbooks

- `/home/ebatter1/Documents/openclaw-safe-install/LOCAL-FIRST-MODEL-STACK.md`
- `/home/ebatter1/Documents/openclaw-safe-install/README.md`
- `/home/ebatter1/Documents/OPENCLAW-CODEX-ON-DEMAND.md`

# Change history

- 2026-04-22: Created a focused runbook for the live OpenAI Codex OAuth order, fallback profiles, and session override recovery.
