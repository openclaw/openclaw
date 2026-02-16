# Research: Zero-Friction Docker MongoDB Auto-Onboarding

## Knowledge Gap

How to make MongoDB setup fully automatic in the ClawMongo onboarding wizard — so users never manually run Docker or MongoDB commands.

## Research Conducted

- Patterns from production CLIs: Supabase, Localstack, Firebase Emulators
- Docker SDK options for Node.js: dockerode, execa, native child_process.spawn
- Edge case analysis: all failure modes in Docker + MongoDB lifecycle
- Existing codebase: src/agents/sandbox/docker.ts (spawn pattern), docker/mongodb/start.sh (wrapper), docker-compose.mongodb.yml

## Key Findings

### 1. Production CLI Patterns

**Supabase (Go, docker.go):**

- Uses Docker Go SDK for container management
- Port conflict detection before starting services
- Healthy container reuse (checks labels + health status)
- Progressive image pull with progress bars
- Named volumes for persistence

**Localstack (Python):**

- Rich exception hierarchy: DockerNotAvailable, DockerNotRunning, ContainerStartFailed
- Two-step Docker detection: CLI installed → daemon running
- Container lifecycle management: create, start, stop, health check
- Graceful degradation with clear error messages

**Firebase Emulators:**

- Auto-download JARs if not present
- Port conflict detection and auto-reassignment
- Parallel service startup with health checks
- Clear terminal output showing all running services

### 2. Docker Detection Strategy

**Two-step check (the industry standard):**

1. `docker --version` — Is Docker CLI installed?
   - If fails: Show install instructions per platform (Docker Desktop for macOS/Windows, docker.io for Linux)
   - DO NOT auto-install Docker (too invasive, security implications)

2. `docker ps` (or `docker info`) — Is the daemon running?
   - If fails: "Docker Desktop is not running. Please start it."
   - DO NOT auto-start the daemon (permissions, platform differences)

**Additional signal:** Check `/var/run/docker.sock` existence (Linux/macOS)

### 3. Docker SDK Comparison

| Approach     | Size    | API             | Used by                   | Fits ClawMongo?       |
| ------------ | ------- | --------------- | ------------------------- | --------------------- |
| dockerode    | ~5-10MB | Full Docker API | Testcontainers, portainer | Overkill              |
| execa        | ~200KB  | CLI wrapper     | Many CLIs                 | Good but external dep |
| native spawn | 0KB     | child_process   | **Already in codebase**   | Best fit              |

**Decision: Use native spawn** — `src/agents/sandbox/docker.ts` already has `execDockerRaw()` and `execDocker()` wrappers with:

- Error handling (stderr capture, exit codes)
- AbortSignal support
- Container state inspection (`dockerContainerState()`)
- Image existence check (`dockerImageExists()`)
- Port reading (`readDockerPort()`)

No new dependencies needed.

### 4. Edge Cases to Handle

| Edge Case                     | Detection                                  | Response                                 |
| ----------------------------- | ------------------------------------------ | ---------------------------------------- |
| Docker not installed          | `docker --version` fails                   | Show install link, offer manual URI      |
| Docker daemon not running     | `docker ps` fails                          | "Start Docker Desktop", offer manual URI |
| Port 27017 already in use     | `docker port` or `lsof -i :27017`          | Check if it's MongoDB, reuse if so       |
| Images not pulled             | `docker image inspect` fails               | Pull with progress indicator             |
| Container already exists      | `docker ps -a --filter name=clawmongo-*`   | Check health, reuse if healthy           |
| Network/volume conflicts      | docker-compose exit code                   | Clean recreate with user consent         |
| Permissions error             | stderr contains "permission denied"        | Suggest `sudo` or Docker group           |
| Docker Compose v1 vs v2       | `docker compose version`                   | Fall back to `docker-compose` if needed  |
| Existing MongoDB (not Docker) | Connect to localhost:27017, check topology | Reuse existing, skip Docker              |

### 5. Smart Detection for Existing MongoDB

Before auto-starting Docker, check if MongoDB is already running:

```
1. Try connect to mongodb://localhost:27017 (5s timeout)
2. If connected → detect topology → offer to reuse
3. If not connected → proceed with Docker auto-start
```

This avoids:

- Starting duplicate MongoDB when one already exists
- Port conflicts between existing and Docker MongoDB
- Confusing users who already set up MongoDB manually

### 6. Fallback Tier Strategy

```
IDEAL PATH (most features):
  Docker detected → Pull images → Start fullstack → Connect → Detect topology → Configure

FALLBACK 1 (no mongot):
  Docker detected → Pull fails for mongot image → Start replicaset only → Warn about missing vector search

FALLBACK 2 (no replica set):
  Docker detected → Something fails → Start standalone → Warn about missing transactions + search

FALLBACK 3 (no Docker):
  Docker NOT detected → Prompt for manual MongoDB URI → Detect topology → Configure

FALLBACK 4 (nothing works):
  Everything fails → Use builtin (SQLite) backend → Suggest Docker setup for later
```

### 7. UX Patterns — "Invisible Docker"

The best DX is when users don't think about Docker at all:

1. **No Docker jargon in happy path** — Say "Starting MongoDB..." not "Running docker-compose..."
2. **Progress indicators** — Show what's happening (pulling images, starting services, waiting for health)
3. **Automatic cleanup** — Stop containers when openclaw exits (or keep running for next session)
4. **Reconnection** — If Docker MongoDB is already running, just reconnect
5. **Upgrade path** — If standalone detected, suggest "Upgrade to full stack?" (runs the fullstack docker-compose)

### 8. What Should NOT Be Done (Yet)

- **Don't auto-install Docker** — Too invasive, security implications
- **Don't auto-start Docker daemon** — Platform-specific, needs user action
- **Don't auto-pull images silently** — Images are large (~500MB+), need user consent or at least progress
- **Don't auto-upgrade tiers without asking** — User may prefer standalone for simplicity
- **Don't add new dependencies** — Use existing spawn/execDocker pattern

## Application to ClawMongo

### Architecture Overview

```
Onboarding Wizard (onboarding-memory.ts)
  ├── Step 1: Detect existing MongoDB (try connect localhost:27017)
  │     ├── Found → Detect topology → Auto-configure
  │     └── Not found → Step 2
  ├── Step 2: Detect Docker
  │     ├── Docker ready → Step 3
  │     └── Docker not ready → Step 4 (manual URI)
  ├── Step 3: Auto-start MongoDB via Docker
  │     ├── Pull images (with progress)
  │     ├── Start fullstack (with fallback to replicaset → standalone)
  │     ├── Wait for health
  │     └── Auto-configure with detected URI
  └── Step 4: Manual URI (existing path)
        ├── User enters URI
        └── Detect topology → Configure
```

### What to Reuse

1. `execDocker()` and `execDockerRaw()` from `src/agents/sandbox/docker.ts`
2. `start.sh` logic adapted into TypeScript for programmatic control
3. `detectTopology()` from `src/memory/mongodb-topology.ts`
4. `docker-compose.mongodb.yml` as the Docker Compose spec

### What to Create

1. `src/docker/mongodb-docker.ts` — Docker detection, image management, compose orchestration
2. Modifications to `src/wizard/onboarding-memory.ts` — New auto-setup flow before manual URI
3. Health check and readiness polling functions
4. Progress reporting integration with @clack/prompts spinner

### Key Design Decisions

1. **Fullstack by default** — Always try fullstack first, fall back to simpler tiers
2. **No new dependencies** — Use native spawn (execDocker pattern already exists)
3. **Graceful degradation** — Every step has a fallback, users always get working MongoDB
4. **Existing MongoDB detection** — Check before starting Docker to avoid conflicts
5. **Progress indicators** — Users see what's happening, not a hanging terminal

## References

- Supabase CLI Docker patterns: github.com/supabase/cli (Go, internal/docker)
- Localstack Docker patterns: github.com/localstack/localstack (Python, docker_utils)
- Firebase Emulators: firebase.google.com/docs/emulator-suite
- Existing codebase: src/agents/sandbox/docker.ts
- Docker Compose spec: docker/mongodb/docker-compose.mongodb.yml
- Quick-start script: docker/mongodb/start.sh
