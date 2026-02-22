# Gemini 3.1 Pro Preview — Setup Guide

## Overview

This guide explains how to use `gemini-3.1-pro-preview` in OpenClaw via Google's Cloud Code Assist API with OAuth authentication (Gemini CLI subscription — no API key needed).

## Prerequisites

1. **Gemini CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic/gemini-cli   # or however you installed it
   gemini   # first run triggers OAuth login
   ```
2. **OAuth credentials** at `~/.gemini/oauth_creds.json` (created automatically by Gemini CLI)
3. **OpenClaw** with Gemini 3.1 support (this branch or later)

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────────────────┐
│  OpenClaw    │ ──▶ │  pi-ai SDK       │ ──▶ │  Cloud Code Assist API       │
│  (gateway)   │     │  (google-gemini-  │     │  cloudcode-pa.googleapis.com │
│              │     │   cli provider)   │     │  /v1internal:stream...       │
└─────────────┘     └──────────────────┘     └──────────────────────────────┘
       │                                              │
       │  OAuth token + projectId                     │  gemini-3.1-pro-preview
       │  from auth-profiles.json                     │  model name in request
       └──────────────────────────────────────────────┘
```

### Model Details

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Provider       | `google-gemini-cli`                     |
| Model ID       | `gemini-3.1-pro-preview`                |
| Alias          | `gemini31`                              |
| API            | `google-gemini-cli` (Cloud Code Assist) |
| Context Window | 1,024,000 tokens                        |
| Max Output     | 65,536 tokens                           |
| Input          | text + image                            |
| Reasoning      | ✅ (thinkingLevel support)              |
| Cost           | Free (Gemini subscription)              |

## Usage

### Set as session model

```
/model gemini31
```

### Spawn a sub-agent with Gemini 3.1

```
model=gemini31 in session config
```

### CLI

```bash
openclaw models list | grep gemini-3.1
# google-gemini-cli/gemini-3.1-pro-preview   text+image 1024k    no    yes   configured,alias:gemini31
```

## Known Issue: Custom Models + apiKey Validation

### Problem

pi-ai's `loadCustomModels()` validates that **every** provider with custom models in `models.json` has an `apiKey` field. If **any** provider fails this check, **all** custom models are silently dropped.

This can cause `gemini-3.1-pro-preview` to show as `configured,missing` even though its own config is correct.

### Symptom

```bash
openclaw models list | grep gemini-3.1
# google-gemini-cli/gemini-3.1-pro-preview   -   -   -   -   configured,missing
```

### Root Cause

Another provider in `openclaw.json` (commonly `openai-codex`) defines models without an `apiKey` field. Since Codex uses OAuth, there's no real API key — but pi-ai's schema validation doesn't distinguish OAuth-based providers.

### Fix

Add a placeholder `apiKey` to any provider in `openclaw.json` that has `models` but no `apiKey`:

```json
{
  "models": {
    "providers": {
      "openai-codex": {
        "baseUrl": "https://chatgpt.com/backend-api",
        "api": "openai-responses",
        "apiKey": "codex-oauth-placeholder",
        "models": [...]
      }
    }
  }
}
```

> **Note:** The placeholder `apiKey` is only used to pass pi-ai's config validation. Actual authentication uses OAuth tokens from `auth-profiles.json`. It does NOT affect your OpenAI/Codex subscription or API calls.

### Why This Happens

```
loadCustomModels() iterates ALL providers in models.json
  → openai-codex has models but no apiKey
  → throws Error("Provider openai-codex: apiKey is required...")
  → catch block returns emptyCustomModelsResult()
  → ALL custom models dropped (including valid ones)
```

The validation is all-or-nothing — one provider failure kills the entire custom models pipeline.

## Thinking Level Support

Gemini 3.1 models use `thinkingLevel` (enum: `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) instead of the `thinkingBudget` (token count) used by Gemini 2.x models.

pi-ai's built-in check (`model.id.includes("3-pro")`) doesn't match `"3.1-pro"`, so OpenClaw applies a runtime `onPayload` wrapper that:

1. Intercepts the request payload before it's sent
2. If `thinkingBudget` is present, converts it to the appropriate `thinkingLevel`
3. Removes `thinkingBudget` from the config

### Conversion Table

| Budget Tokens   | → thinkingLevel      |
| --------------- | -------------------- |
| 0 (or disabled) | _(thinking removed)_ |
| 1 – 1,024       | `LOW`                |
| 1,025 – 8,192   | `MEDIUM`             |
| 8,193+          | `HIGH`               |

This is a forward-compatibility patch. When pi-ai natively supports Gemini 3.1, this wrapper becomes a no-op.

## Architecture Notes

### Why runtime injection (not config-only)?

Adding `gemini-3.1-pro-preview` to `openclaw.json` alone results in `Auth=no / available=false` because:

- Config-added models don't automatically link to existing OAuth profiles
- The provider's `api` type must be `google-gemini-cli` (not `google-generative-ai`)
- The `baseUrl` must be `cloudcode-pa.googleapis.com` (not `generativelanguage.googleapis.com`)

OpenClaw injects the model at runtime via `buildGeminiCliExtraModelsProvider()` when it detects active `google-gemini-cli` OAuth profiles.

### Files Modified

| File                                            | Purpose                                 |
| ----------------------------------------------- | --------------------------------------- |
| `src/agents/models-config.providers.ts`         | Model definition + provider injection   |
| `src/agents/pi-embedded-runner/extra-params.ts` | thinkingLevel wrapper                   |
| `src/config/types.models.ts`                    | `"google-gemini-cli"` in ModelApi union |
| `src/agents/opencode-zen-models.ts`             | Zen model catalog entry                 |
| `src/config/defaults.ts`                        | `"gemini-3.1"` → `"gemini31"` alias     |
