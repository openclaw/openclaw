# MoltAssist 🦞

**Autonomous task execution for OpenClaw.**

Load a checklist. Assign to specialists. Execute via local LLM. Verify. Ship.

Like an F1 pit crew for your codebase — every agent has one job, executes in parallel, zero wasted motion.

## Why

You have a TODO list. You have a local GPU. Why are you doing this manually?

MoltAssist reads your markdown checklists, breaks them into atomic tasks, routes each task to a specialist agent via ternary gene matching (no embeddings, no APIs), and executes them through an uncensored local model.

## Quick Start

```bash
# Install
pip install moltassist

# Run against a checklist
moltassist run TODO.md

# Run with auto-execute (shell commands run automatically)
moltassist run TODO.md --auto-execute

# Use a specific model
moltassist run TODO.md --model dolphin-mixtral:8x7b

# Just plan, don't execute
moltassist plan TODO.md
```

## As a Library

```python
from moltassist import PitCrew, LocalRunner

runner = LocalRunner(tier="medium")  # wizard-vicuna-uncensored:13b
crew = PitCrew()
crew.load("MASTER_SOP.md")
print(crew.run(executor=runner.execute))
```

## How It Works

1. **Parse** — Reads markdown checklists (`- [ ] task`) into atomic tasks
2. **Gene** — Each task gets a 48-trit ternary gene from its description (SHA-256 → balanced ternary)
3. **Match** — Cavity resonance routing matches tasks to specialist agents (Scout, Builder, Tester, Washer, Deployer, Verifier)
4. **Execute** — Local LLM plans and optionally runs shell commands
5. **Verify** — Completion checks via commands, file existence, or imports
6. **Report** — ASCII status board shows progress

## Agent Types

| Type | Signature | Job |
|------|-----------|-----|
| Scout | explore, search, find | Explore codebase, locate files |
| Builder | write, create, build | Write code, generate files |
| Tester | test, verify, check | Run tests, validate outputs |
| Washer | scrub, clean, purge | Remove secrets, clean data |
| Deployer | deploy, install, ship | SCP, install, configure |
| Verifier | confirm, endpoint, status | Health checks, ping endpoints |

Routing is deterministic — same task description always goes to the same agent type. No randomness, no embeddings API, no cloud calls.

## Model Tiers

| Tier | Model | VRAM | Speed |
|------|-------|------|-------|
| heavy | dolphin-mixtral:8x7b | 24GB | Slow, best reasoning |
| medium | wizard-vicuna-uncensored:13b | 7GB | Good balance |
| light | dolphin-llama3:8b | 4GB | Fast |
| tiny | dolphin-phi:2.7b | 1.5GB | Instant |

All models are abliterated (uncensored). They execute tasks without refusing, hedging, or asking permission.

## Checklist Format

Any markdown with checkboxes works:

```markdown
# My Project

## Phase 1
- [x] Already done
- [ ] Scrub API keys from repo
- [ ] Run test suite
- [ ] Deploy to staging

## Phase 2
- [ ] Write documentation
- [ ] Create release tag
```

Projects are detected from `## PROJECT N: Name` headers (SOP format) or inferred from `##` headers.

## Requirements

- Python 3.10+
- [Ollama](https://ollama.com) running locally
- Any abliterated model pulled (`ollama pull dolphin-llama3:8b`)
- A GPU (CPU works but slow)

## License

MIT — same as OpenClaw.

## Credits

Built by [AnnulusLabs LLC](https://annuluslabs.com), Taos, New Mexico.
Part of the OpenClaw ecosystem.
