# MoltAssist 🦞

**Autonomous task execution for OpenClaw.** Written in Rust.

Load a checklist. Route to specialists. Execute via local LLM. Ship.

## Install

```bash
cargo install --path extensions/moltassist
```

Or grab a release binary from [Releases](https://github.com/openclaw/openclaw/releases).

## Usage

```bash
# Execute a markdown checklist
moltassist run TODO.md --tier medium

# Auto-execute shell commands from LLM plans
moltassist run TODO.md --auto-execute

# Plan without executing
moltassist plan TODO.md

# List available models
moltassist models

# Check saved state
moltassist status TODO_state.json
```

## How It Works

1. **Parse** — Reads markdown checklists (`- [ ] task`) into atomic tasks
2. **Gene** — Each task gets a 48-trit balanced ternary gene via SHA-256
3. **Route** — Cosine similarity in trit space matches tasks to specialist agents
4. **Execute** — Local abliterated LLM plans and optionally runs commands
5. **Report** — Colored ASCII status board shows progress

### Gene Routing

No embeddings. No cloud APIs. No vector databases.

Every task description is hashed to a 48-trit balanced ternary gene `{-1, 0, +1}`.
Every agent type has a fixed gene from its role description.
Routing = cosine similarity between task gene and agent genes.
Same input always routes to the same agent. Deterministic. Instant. Offline.

### Agent Types

| Type | Routes to | Signature |
|------|-----------|-----------|
| Scout | explore, search, find | `+0-+0+00-+0-+-0+0-+00+-+0...` |
| Builder | write, create, build | `0+-0++0-+0+-+0-+0+0-+-00+...` |
| Tester | test, verify, check | `-+0+0-+00+0-++-0-+0+-0+0-...` |
| Washer | scrub, clean, purge | `0-+0-+0+0+-0+0-+-+0-+00+-...` |
| Deployer | deploy, install, ship | `+0+0-+-+0+0-+0+-0-+0+0-+0...` |
| Verifier | confirm, endpoint, status | `-0+0+-0+0-+0+0-+0+-0-+0+0...` |

### Model Tiers

| Tier | Model | VRAM | Use Case |
|------|-------|------|----------|
| heavy | dolphin-mixtral:8x7b | 24GB | Complex reasoning |
| medium | wizard-vicuna-uncensored:13b | 7GB | General tasks |
| light | dolphin-llama3:8b | 4GB | Fast iteration |
| tiny | dolphin-phi:2.7b | 1.5GB | Instant planning |

All models are abliterated — they execute without refusing or hedging.

## Checklist Format

Any markdown with checkboxes:

```markdown
## My Project
- [x] Already done
- [ ] Scrub API keys from repo
- [ ] Run test suite
- [ ] Deploy to staging
```

SOP format also supported:

```markdown
## PROJECT 1: Backend
- [ ] Build auth module
- [ ] Write tests

## PROJECT 2: Frontend
- [ ] Create login page
```

## Requirements

- [Ollama](https://ollama.com) running locally
- Any model pulled (`ollama pull dolphin-llama3:8b`)
- A GPU (CPU works but slower)

## Build

```bash
# Requires Rust nightly
cargo build --release

# Cross-compile for Linux
cargo build --release --target x86_64-unknown-linux-gnu
```

## Architecture

```
src/
  main.rs     — CLI (clap) + orchestration
  gene.rs     — SHA-256 → balanced ternary gene encoding
  task.rs     — Task struct, priority inference, state machine
  dispatch.rs — Cavity-resonance agent routing
  manifest.rs — Markdown checklist parser
  runner.rs   — Ollama LLM executor
  board.rs    — Colored ASCII status board
  verify.rs   — Task completion verification
```

Zero runtime dependencies beyond Ollama. Single static binary. ~2.5MB stripped.

## License

MIT — same as OpenClaw.

Built by [AnnulusLabs LLC](https://annuluslabs.com), Taos, New Mexico.
