# ADR-004: Proxy Lifecycle Management

## Status: ACCEPTED

## Date: 2026-02-13 (v2 — updated with security hardening from research)

## Bounded Context: Infrastructure (Proxy Management)

## Context

The claude-code-proxy Docker container is a critical infrastructure dependency for
the Cloud.ru FM integration. It must be deployed, monitored, and recoverable.
The wizard handles initial deployment, and OpenClaw verifies proxy health before routing.

### Research Findings

From RESEARCH.md and community experience:

- Proxy is the SINGLE point of failure — if proxy dies, ALL model tiers are unreachable
- `curl` in Docker healthcheck conflicts with `read_only: true` (CRIT-03)
- Port binding MUST include both `127.0.0.1` AND `[::1]` to prevent network exposure
- `MAX_TOKENS` defaults to 4096 — too small for code generation; recommend override
- `REQUEST_TIMEOUT` defaults to 90s — may timeout for long GLM-4.7 generations

### DDD Aggregate: ProxyLifecycle

Manages the proxy container state machine:

```
UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY
                                     |
                                 UNHEALTHY -> RECOVERING -> HEALTHY
                                     |
                                 STOPPED
```

## Decision

### 1. Docker Compose Generation

The wizard generates a `docker-compose.cloudru-proxy.yml` file in the OpenClaw
workspace directory. This file is NOT committed to git (added to .gitignore).

### 2. Security-Hardened Container (CRIT-03 Fix)

```yaml
services:
  claude-code-proxy:
    image: legard/claude-code-proxy:v1.0.0 # Pinned, not :latest
    container_name: claude-code-proxy
    ports:
      - "127.0.0.1:8082:8082" # IPv4 localhost ONLY
      - "[::1]:8082:8082" # IPv6 localhost ONLY
    env_file:
      - .env
    environment:
      - HOST=0.0.0.0
      - PORT=8082
      - LOG_LEVEL=INFO
      - MAX_TOKENS_LIMIT=16384 # Override default 4096
      - REQUEST_TIMEOUT=300 # 5 min for long generations
    restart: unless-stopped
    read_only: true # No filesystem writes
    user: "65534:65534" # nobody:nogroup
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8082/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s
```

**Key fixes**:

- `wget -q --spider` instead of `curl` — works with `read_only: true`
- Image pinned to `v1.0.0` — no surprise updates
- `cap_drop: ALL` + `user: nobody` + `read_only` — minimal attack surface
- `MAX_TOKENS_LIMIT=16384` — sufficient for code generation
- `REQUEST_TIMEOUT=300` — 5 minutes for GLM-4.7 long generations

### 3. .env File Management (CRIT-05 Fix)

`.env` file must be managed with append semantics:

```typescript
// CORRECT: read-merge-write (not overwrite)
async function writeCloudruEnvFile(dir: string, apiKey: string, preset: CloudruModelPreset) {
  const envPath = path.join(dir, ".env");
  const existing = await fs.readFile(envPath, "utf-8").catch(() => "");
  const entries = parseEnvEntries(existing);

  // Merge new values (overwrite only cloudru-related keys)
  entries.set("OPENAI_API_KEY", apiKey);
  entries.set("OPENAI_BASE_URL", CLOUDRU_BASE_URL);
  entries.set("BIG_MODEL", preset.big);
  entries.set("MIDDLE_MODEL", preset.middle);
  entries.set("SMALL_MODEL", preset.small);

  await fs.writeFile(envPath, serializeEnvEntries(entries));
}
```

### 4. Health Check Integration

Two levels of health checking:

**Wizard-time** (during onboarding):

```
If Docker running -> check /health -> show status
If Docker not running -> offer to start with `docker compose up -d`
If Docker not installed -> show manual setup instructions
```

**Runtime** (before each request):

```typescript
// cloudru-proxy-health.ts — cached 30s on success, not cached on failure
// Throws plain Error (not FailoverError) — all tiers share same proxy
await ensureProxyHealthy("http://localhost:8082");
```

### 5. Gitignore Entries

Wizard ensures these entries exist in `.gitignore`:

```
docker-compose.cloudru-proxy.yml
.env
```

## Consequences

### Positive

- Automated proxy deployment from wizard
- Security-hardened container (read-only, non-root, capped resources)
- Health monitoring prevents silent failures
- Docker restart policy handles transient crashes
- .env append preserves existing environment

### Negative

- Requires Docker installed on host
- docker-compose file is workspace-specific
- Health check adds latency to first request after cache expiry (30s TTL)
- No automatic proxy image updates (intentional — stability over freshness)

### Security (from Research)

> **CRITICAL**: Ports MUST be bound to `127.0.0.1` and `[::1]` ONLY.
> Without this, any user on your network can discover the proxy and use your API key.

- `.env` file with real API key MUST be in .gitignore
- Container runs as `nobody` with `cap_drop: ALL`
- `read_only: true` prevents container filesystem modifications
- API key never appears in openclaw.json (only in .env)
- Compliant with Cloud.ru security requirements (FSTEC)

## References

- `src/agents/cloudru-proxy-template.ts` — Docker compose generator
- `src/agents/cloudru-proxy-health.ts` — Health check with caching
- `docs/ccli-max-cloudru-fm/RESEARCH.md` — Section 2.2 (proxy setup), 2.5 (security)
- [claude-code-proxy Docker Hub](https://hub.docker.com/r/legard/claude-code-proxy)
