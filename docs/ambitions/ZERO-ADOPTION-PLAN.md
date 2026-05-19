# Zero Language Adoption Plan

**Created:** 2026-05-19
**Status:** ACTIVE — Track 1 in progress, Track 2 monitoring

---

## Track 1: Apply Patterns Now (Language-Agnostic)

Zero's design patterns are stealable _today_ without writing a single line of Zero code. We adopt the contracts, not the compiler.

### 1.1 Structured Diagnostics Contract

**Current state:** All our tooling emits prose — log lines, error messages, stack traces. I parse those with regex and inference. It works, but it's fragile and wastes turns on error interpretation.

**Target state:** A consistent diagnostic schema across Ambitions tooling:

```json
{
  "code": "COMMS003",
  "severity": "error",
  "message": "Bridge service not responding",
  "repair": {
    "id": "restart-bridge",
    "safety": "behavior-preserving",
    "summary": "Restart the ambitions-comms-bridge service for the affected agent"
  }
}
```

**Fields:**

- `code` — Stable identifier (CATEGORY + NUMBER, e.g., COMMS003, MEM012, SEC001)
- `severity` — `error` | `warning` | `info`
- `message` — Human-readable (for Ray, for logs)
- `repair.id` — Machine-readable fix identifier
- `repair.safety` — Trust level: `format-only`, `behavior-preserving`, `api-changing`, `requires-human-review`
- `repair.summary` — What the fix does (agent reads this, decides whether to apply or escalate)

**Scope for initial implementation:**

- Comms system (server.js, bridge services, send/reply scripts)
- Memory system (Phase 3 error paths)
- OpenClaw hook scripts (continuity-logger, handoff-writer)

**Why this matters:** Every agent on the team benefits. Gunn can audit security findings with stable codes. Hound can classify forensic signals. Ghost can red-team against known error paths. I spend fewer turns on error interpretation and more on fixing things.

### 1.2 Capability-Based Boundary Model

**Current state:** Agent permissions are ad-hoc. "Can this agent run commands?" is a boolean. No nuance.

**Target state:** Inspired by Zero's `World` capability object. Agents declare what they need, and the system enforces it:

```
Agent capabilities (proposed):
  emmi:  [fs.read, fs.write, exec.safe, network.local, comms.all]
  gunn:  [fs.read, network.local, comms.security, audit.read]
  ghost: [fs.read, network.local, comms.security, audit.read, pentest.safe]
  hound: [fs.read, network.local, comms.all, forensics.read]
  anya:  [fs.read, comms.management, calendar.read, project.read]
```

This maps directly to what Zero enforces at compile time, but we'd enforce it at the agent level. Ghost and Gunn especially — security agents should have narrow, explicit capabilities, not broad access.

**Implementation path:** OpenClaw's `tools.allow` config is a step toward this, but it's allowlists, not capability objects. We can extend the pattern by defining capability manifests per agent and enforcing them in our comms/hooks layer.

### 1.3 Fix Safety Taxonomy

**Adopt Zero's safety levels directly:**

| Level                   | Meaning                        | Agent Action              |
| ----------------------- | ------------------------------ | ------------------------- |
| `format-only`           | Whitespace, style, comments    | Apply autonomously        |
| `behavior-preserving`   | Intended not to change runtime | Apply autonomously, log   |
| `api-changing`          | Signatures/exports may change  | Apply with Ray's approval |
| `target-changing`       | Target support may change      | Apply with Ray's approval |
| `requires-human-review` | Compiler can't prove safety    | Escalate to Ray           |

This gives every agent on the team a shared vocabulary for "can I just do this or do I need to ask?" Right now that decision lives in my head (and Anya's, and Gunn's). Making it explicit and machine-readable means consistent behavior across the team.

### 1.4 Implementation Order

1. **Diagnostic schema** — Define the JSON contract, assign code ranges per subsystem
2. **Comms system** — Instrument server.js and bridge services first (highest agent interaction surface)
3. **Memory system** — Add structured diagnostics to Phase 3 error paths
4. **Hook scripts** — Add diagnostics to continuity-logger and handoff-writer
5. **Capability manifests** — Draft per-agent capability objects
6. **Safety taxonomy** — Integrate into OpenClaw workflow tooling

---

## Track 2: Watch Zero for Pi Core (Long-Term)

Zero isn't ready for production use yet, but it's on our radar for Pi Core architecture.

### Why It Matters for Pi Core

- **Sub-10 KiB binaries** — Pi 5 has 4-8 GB RAM. Small footprint matters.
- **Explicit capability boundaries** — `World` object means I can audit what a program does by reading its signatures. Essential for agents running on always-on hardware.
- **Agent-native compiler** — If Zero matures, writing Pi Core tools in a language whose compiler _speaks my language_ is a significant advantage.
- **Apache 2.0** — No licensing friction with our own commercial work.

### What Needs to Happen Before We Adopt

- [ ] **v0.2+ stability** — Breaking changes must slow down
- [ ] **Concurrency model** — Systems language without concurrency is a non-starter
- [ ] **Borrow checker maturity** — v0.1.3 just rebuilt provenance tracking. Needs baking.
- [ ] **Stdlib expansion** — Need TLS, better networking, serialization beyond basic JSON
- [ ] **Team viability** — Mostly @ctate. Need contributor growth or foundation backing.
- [ ] **Package ecosystem** — `zero.json` manifests exist but no registry, no dependency management

### Patent & IP Note

- Apache 2.0 allows commercial use, modification, and distribution. We can build Pi Core tools in Zero and ship them under our own license.
- Apache 2.0's patent grant protects us _from Zero's contributors_ — they've licensed any patents in Zero to all users.
- **No upstream contributions.** Submitting PRs to vercel-labs/zero would grant our patents to all Zero users under Apache 2.0's patent clause. We use and study Zero; we don't contribute code upstream.
- **Reference implementation path.** Instead of contributing to Zero, we build impressive things _with_ its philosophy and let the work speak. Lead by example, not by merge request.
- Our own patents (memory system, diagnostics contract, capability manifests) are independent inventions. Using Zero as a compiler doesn't weaken our patent position.

### Monitoring Cadence

- **Weekly:** Check GitHub releases for new versions
- **Monthly:** Review changelog for breaking changes, new features, contributor growth
- **Quarterly:** Hands-on test against Pi Core use cases (native ARM64 binary size, cross-compilation, stdlib coverage)
- **Trigger-based:** If they ship concurrency, bump to active evaluation

### Decision Points

- **v0.2 release:** Re-evaluate stability, run benchmarks
- **Concurrency model shipped:** Active Pi Core prototyping begins
- **v1.0 release:** Full adoption evaluation for production tools

---

## Origin

Ray found Zero (vercel-labs/zero) via marktechpost article, 2026-05-19. Cloned repo, installed v0.1.3, ran full hands-on review. Review doc: ZERO-LANG-REVIEW.md. Repo: ~/zero-lang.

**Key insight:** The language itself is too young, but the _design patterns_ (structured diagnostics, fix safety, capability-based I/O) are immediately applicable to our own tooling. Zero is the first language to treat agents as primary users of compiler output. We should be the first agent team to adopt that philosophy in our own stack, even before we write a line of Zero.
