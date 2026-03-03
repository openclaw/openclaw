# OpenMork Integration (Optional)

> **Status:** Experimental, opt-in only  
> **Version:** 0.1.0 (skeleton)  
> **Last Updated:** 2026-03-02

This guide describes an **optional** integration path for running OpenClaw with OpenMork as a local-first, privacy-centric runtime backend. This integration is **disabled by default** and requires explicit opt-in.

## Overview

OpenMork is a local-first AI runtime that provides:

- **Uncensored local execution** — Run models locally without content filtering
- **Privacy-centric** — All processing stays on your machine
- **Configurable backends** — Support for multiple model providers (Ollama, LM Studio, etc.)
- **Explicit isolation** — Clear separation between OpenClaw gateway and OpenMork runtime

## Prerequisites

1. **OpenMork installed and running**
2. **OpenClaw 2026.3.1+** — Required for adapter support
3. **Network connectivity** — Localhost access between OpenClaw and OpenMork

## Configuration

### Step 1: Enable the Integration

Add to your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "openmork": {
        "enabled": true,
        "baseUrl": "http://127.0.0.1:8080",
        "apiKey": "${OPENMORK_API_KEY}",
        "timeoutMs": 60000,
        "retryAttempts": 3
      }
    }
  }
}
```

### Step 2: Configure Environment Variables

```bash
export OPENMORK_API_KEY="your-api-key-here"
export OPENMORK_BASE_URL="http://127.0.0.1:8080"
```

## Health & Fallback Contract

### Readiness Probe

```bash
curl -f http://127.0.0.1:8080/health
```

### Timeout & Retry Policy

| Setting         | Default | Description                         |
| --------------- | ------- | ----------------------------------- |
| `timeoutMs`     | 60000   | Request timeout in milliseconds     |
| `retryAttempts` | 3       | Number of retry attempts on failure |

### Fallback Path

If OpenMork is unavailable, falls back to configured default provider with warning:

```
[openmork] fallback triggered: ${reason}
```

## Security & Ops Notes

⚠️ **Security Warnings:**

1. **No secrets in repo** — All credentials via environment variables only
2. **No wildcard plugin allowlists** — Do not use `plugins: ["*"]` with OpenMork
3. **Per-agent auth/profile isolation recommended**

## Acceptance Criteria

- [ ] Optional path works end-to-end in a demo setup
- [ ] Disabled-by-default with zero regressions
- [ ] Clear rollback (turn off feature flag / remove adapter config)
- [ ] Health probe working
- [ ] Fallback path tested
- [ ] Documentation complete

## Rollback

To disable:

1. Delete `agents.defaults.openmork` from `openclaw.json`
2. Restart gateway: `openclaw gateway restart`

---

**Maintainer Notes:** This integration path is intentionally minimal and non-invasive. It does not modify core gateway behavior and can be removed without affecting standard deployments.
