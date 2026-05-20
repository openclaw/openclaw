# Ambitions Structured Diagnostics Specification

**Version:** 0.1.0-draft
**Created:** 2026-05-19
**Status:** DRAFT — implementing in comms system first
**Origin:** Inspired by Zero language's agent-first compiler output (vercel-labs/zero v0.1.3)

---

## 1. Design Philosophy

Every tool in the Ambitions stack should speak in structured diagnostics, not prose. When something breaks, the agent (or human) reading the output should know:

1. **What happened** (stable code)
2. **How to fix it** (repair ID)
3. **Whether it's safe to fix without asking** (safety level)

This is the contract. Code + repair + safety. Every error, every warning, every diagnostic.

---

## 2. Diagnostic Schema

### 2.1 Top-Level Structure

```json
{
  "ok": false,
  "diagnostics": [
    {
      "code": "COMMS003",
      "severity": "error",
      "message": "Bridge service not responding for agent 'emmi'",
      "line": null,
      "context": {
        "agent": "emmi",
        "service": "ambitions-comms-bridge@emmi",
        "lastSeen": "2026-05-19T10:00:00Z"
      },
      "repair": {
        "id": "restart-bridge",
        "safety": "behavior-preserving",
        "summary": "Restart the bridge service for the affected agent"
      }
    }
  ]
}
```

### 2.2 Field Definitions

| Field                          | Type         | Required | Description                                               |
| ------------------------------ | ------------ | -------- | --------------------------------------------------------- |
| `ok`                           | boolean      | yes      | `true` if no diagnostics, `false` if any exist            |
| `diagnostics`                  | array        | yes      | List of diagnostic objects (empty if `ok` is true)        |
| `diagnostics[].code`           | string       | yes      | Stable diagnostic code (CATEGORY + NUMBER)                |
| `diagnostics[].severity`       | string       | yes      | One of: `error`, `warning`, `info`                        |
| `diagnostics[].message`        | string       | yes      | Human-readable description                                |
| `diagnostics[].line`           | number\|null | no       | Source line number if applicable                          |
| `diagnostics[].context`        | object       | no       | Arbitrary structured context (agent, service, file, etc.) |
| `diagnostics[].repair`         | object       | no       | Repair hint (absent if no known fix)                      |
| `diagnostics[].repair.id`      | string       | yes      | Stable repair identifier                                  |
| `diagnostics[].repair.safety`  | string       | yes      | Fix safety level (see §3)                                 |
| `diagnostics[].repair.summary` | string       | yes      | Brief description of the repair action                    |

### 2.3 Success Response

```json
{
  "ok": true,
  "diagnostics": []
}
```

Successful operations may also include a `data` field with the response payload. Diagnostics are for problems, not for affirmations.

---

## 3. Fix Safety Taxonomy

Directly adopted from Zero's classification. Agents use this to decide whether to apply a fix autonomously or escalate to Ray.

| Level                   | Meaning                                       | Agent Action                       | Example                                        |
| ----------------------- | --------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `format-only`           | Whitespace, style, comments                   | Apply autonomously                 | Log formatting, output alignment               |
| `behavior-preserving`   | Intended not to change runtime behavior       | Apply autonomously, log the change | Restart a service, retry a failed request      |
| `api-changing`          | Signatures, exports, or interfaces may change | Apply with Ray's approval          | Update an API endpoint, change a config schema |
| `target-changing`       | Target support or environment may change      | Apply with Ray's approval          | Change a port binding, switch runtime target   |
| `requires-human-review` | Compiler/system can't prove safety            | Escalate to Ray, do not apply      | Unknown error state, potential data loss       |

**Default assumption:** If `repair.safety` is absent, treat as `requires-human-review`.

---

## 4. Diagnostic Code Ranges

Each subsystem owns a category prefix and a numeric range. This prevents collisions and makes codes self-documenting.

| Category | Prefix  | Range   | Subsystem                                                              |
| -------- | ------- | ------- | ---------------------------------------------------------------------- |
| COMMS    | `COMMS` | 001-099 | Ambitions Comms (server, bridges, inbox)                               |
| MEM      | `MEM`   | 001-099 | Memory system (embeddings, storage, search)                            |
| SEC      | `SEC`   | 001-099 | Security (firewall, audit, auth, identity)                             |
| CORE     | `CORE`  | 001-099 | Core spec / continuity system                                          |
| TTS      | `TTS`   | 001-099 | Text-to-speech pipeline                                                |
| HOOK     | `HOOK`  | 001-099 | OpenClaw hooks (handoff, continuity, dreaming)                         |
| PKG      | `PKG`   | 001-099 | Packaging / build / deployment                                         |
| PI       | `PI`    | 001-099 | Pi Core hardware / deployment                                          |
| MGT      | `MGT`   | 001-099 | Management (task coordination, business ops, calendar, project status) |
| RES      | `RES`   | 001-099 | Resource / quota management (token usage, API limits)                  |
| FRN      | `FRN`   | 001-099 | Forensics (evidence integrity, chain-of-custody, timeline analysis)    |

### 4.1 COMMS Codes (Draft)

| Code     | Severity | Message                                      | Repair                                             |
| -------- | -------- | -------------------------------------------- | -------------------------------------------------- |
| COMMS001 | error    | Failed to connect to comms server            | `reconnect-server` (behavior-preserving)           |
| COMMS002 | error    | Authentication token missing or invalid      | `check-token-env` (behavior-preserving)            |
| COMMS003 | error    | Bridge service not responding                | `restart-bridge` (behavior-preserving)             |
| COMMS004 | error    | Inbox read failed                            | `retry-inbox-read` (behavior-preserving)           |
| COMMS005 | error    | Message send failed — channel not found      | `check-channel-name` (format-only)                 |
| COMMS006 | warning  | Inbox pointer corruption detected            | `reset-inbox-pointer` (behavior-preserving)        |
| COMMS007 | error    | DM channel access denied — not a participant | `check-dm-permissions` (requires-human-review)     |
| COMMS008 | warning  | Bridge reconnected after disconnect          | none                                               |
| COMMS009 | info     | Inbox rotation completed                     | none                                               |
| COMMS010 | error    | WebSocket connection refused                 | `check-server-status` (behavior-preserving)        |
| COMMS011 | warning  | Rate limit exceeded — message throttled      | `backoff-retry` (behavior-preserving)              |
| COMMS012 | error    | Message integrity check failed               | `verify-archive-integrity` (requires-human-review) |

### 4.2 MEM Codes (Draft)

| Code   | Severity | Message                              | Repair                                    |
| ------ | -------- | ------------------------------------ | ----------------------------------------- |
| MEM001 | error    | Embedding model not found            | `check-model-path` (behavior-preserving)  |
| MEM002 | error    | Vector search failed — index corrupt | `rebuild-index` (api-changing)            |
| MEM003 | error    | Storage write failed — disk full     | `free-disk-space` (requires-human-review) |
| MEM004 | warning  | Search score below threshold         | `adjust-threshold` (format-only)          |
| MEM005 | error    | ONNX runtime initialization failed   | `check-onnx-deps` (behavior-preserving)   |

### 4.3 SEC Codes (Draft)

| Code   | Severity | Message                                                | Repair                                         |
| ------ | -------- | ------------------------------------------------------ | ---------------------------------------------- |
| SEC001 | info     | UFW rule — port blocked (expected behavior)            | `check-ufw-rules` (format-only)                |
| SEC002 | warning  | Tailscale connection intermittent                      | `check-tailscale-status` (behavior-preserving) |
| SEC003 | error    | Webhook signature verification failed                  | `check-webhook-secret` (requires-human-review) |
| SEC004 | warning  | Failed login attempts exceeded threshold (5 in 10 min) | `review-auth-logs` (requires-human-review)     |
| SEC005 | error    | Agent identity mismatch — token vs claim               | `investigate-identity` (requires-human-review) |

---

## 5. CLI Convention

All Ambitions scripts should support a `--json` flag that emits structured diagnostics instead of prose. This mirrors Zero's `zero check --json` pattern.

```bash
# Human-readable (default):
$ node read-inbox.js emmi
No new messages.

# Structured (for agents):
$ node read-inbox.js emmi --json
{"ok": true, "diagnostics": [], "data": {"unread": 0, "messages": []}}

# Error case:
$ node read-inbox.js emmi --json
{"ok": false, "diagnostics": [{"code": "COMMS004", "severity": "error", ...}]}
```

This gives agents and humans the same output source. No separate parsing paths.

---

## 6. Repair Registry

Each repair ID maps to a known action. This registry lives in code and can be queried.

| Repair ID                  | Safety                | Action                                                                               | Subsystem |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------ | --------- |
| `reconnect-server`         | behavior-preserving   | Retry WebSocket connection to comms server                                           | COMMS     |
| `check-token-env`          | behavior-preserving   | Verify COMMS_API_TOKEN is set in environment                                         | COMMS     |
| `restart-bridge`           | behavior-preserving   | `sudo systemctl restart ambitions-comms-bridge@<agent>`                              | COMMS     |
| `retry-inbox-read`         | behavior-preserving   | Re-read inbox JSONL file                                                             | COMMS     |
| `check-channel-name`       | format-only           | Verify channel name is valid (team, security, management, @agent)                    | COMMS     |
| `reset-inbox-pointer`      | behavior-preserving   | Reset inbox pointer to last known good position                                      | COMMS     |
| `check-dm-permissions`     | requires-human-review | Verify DM participant configuration                                                  | COMMS     |
| `check-server-status`      | behavior-preserving   | Check if ambitions-comms service is running                                          | COMMS     |
| `check-model-path`         | behavior-preserving   | Verify ONNX model file exists at expected path                                       | MEM       |
| `rebuild-index`            | api-changing          | Delete and regenerate vector search index                                            | MEM       |
| `free-disk-space`          | requires-human-review | Free disk space or expand storage                                                    | MEM       |
| `adjust-threshold`         | format-only           | Adjust search score threshold in config                                              | MEM       |
| `check-onnx-deps`          | behavior-preserving   | Verify ONNX runtime dependencies are installed                                       | MEM       |
| `check-ufw-rules`          | format-only           | Review UFW firewall rules (informational, not action-required)                       | SEC       |
| `check-tailscale-status`   | behavior-preserving   | Check Tailscale connection and reconnect if needed                                   | SEC       |
| `check-webhook-secret`     | requires-human-review | Verify webhook secret configuration                                                  | SEC       |
| `review-auth-logs`         | requires-human-review | Review authentication logs for suspicious activity (threshold: 5 failures in 10 min) | SEC       |
| `investigate-identity`     | requires-human-review | Flag for Ghost/Gunn security review — token/claim mismatch                           | SEC       |
| `backoff-retry`            | behavior-preserving   | Wait and retry after rate limit window                                               | COMMS     |
| `verify-archive-integrity` | requires-human-review | Verify archive integrity via SHA-256 manifest — potential tamper signal              | COMMS     |

---

## 7. Integration with OpenClaw Hooks

The continuity-logger and handoff-writer hooks should emit diagnostics when they encounter errors:

```json
{
  "ok": false,
  "diagnostics": [
    {
      "code": "HOOK001",
      "severity": "error",
      "message": "handoff.md write failed — permission denied",
      "repair": {
        "id": "check-file-permissions",
        "safety": "behavior-preserving",
        "summary": "Verify workspace file permissions for handoff.md"
      }
    }
  ]
}
```

---

## 8. Future: Capability Manifests

Phase 2 of Track 1. Per-agent capability manifests declaring what each agent can access.

**Important (Gunn review):** Capabilities must be per-path, not broad categories. `pentest.safe` is too vague. Instead:

```json
{
  "agent": "ghost",
  "capabilities": [
    "fs.read:/etc/ssl",
    "fs.read:/var/log",
    "network.tcp:443",
    "network.tcp:8080",
    "comms.security",
    "audit.read"
  ]
}
```

Explicit paths and ports. Narrow is safer than broad. Manifests must be read-only to agents and modifiable only by Ray (or through a `requires-human-review` repair). Threat modeling for manifest corruption and self-modification attacks is required before implementation (Ghost review).

---

## Implementation Order

1. ✅ Define schema (this document)
2. ✅ Instrument comms system (diagnostics.js + read-inbox.js, send.js, reply.js)
3. ✅ Add `--json` flag to comms CLI scripts
4. ✅ Team review — Ghost (security), Gunn (engineering), Hound (forensics), Anya (management)
5. 🔜 Integrate team feedback into spec (COMMS011-012, SEC005, per-path capabilities, context schema validation)
6. 🔜 Instrument memory system error paths (MEM codes)
7. 🔜 Add diagnostics to OpenClaw hooks (HOOK codes)
8. 🔜 Hound drafts FRN code range
9. 🔜 Anya separates RES code range from MGT
10. 🔜 Threat model capability manifests (Ghost review)
11. 🔜 Draft capability manifests with per-path scoping
12. 🔜 Integrate capability checks into diagnostic emission

---

_This spec is a living document. As we instrument subsystems, we'll discover gaps and add codes. The code ranges are sparse on purpose — room to grow._

**Team review notes (2026-05-19):**

- Ghost: fix safety taxonomy is a security property. Requested COMMS011 (rate limit), COMMS012 (integrity check). Wants threat modeling before capability manifests.
- Gunn: sudoers config must be limited to specific commands. Capabilities must be per-path, not broad. Context fields need schema validation to prevent exfiltration. SEC codes need threat scenarios.
- Hound: FRN001-099 code range for forensics. Fix safety taxonomy maps to her authorization boundary.
- Anya: 99-code MGT range drafted. Quota codes should be RES (own category). MGT096 identity mismatch should be SEC005. Ambiguous intent stays ad-hoc.
- All four team members reviewed and contributed. Framework confirmed. These are hardening passes, not redesigns.
