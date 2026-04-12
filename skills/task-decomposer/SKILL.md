---
name: task-decomposer
description: Break a high-level goal into thin vertical slices with acceptance criteria, test hooks, and risk scoring. Returns structured JSON conforming to task-slice-schema v1.
homepage: https://wiredwisdom.ai/skills/task-decomposer
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🪓",
        "certTier": "certified",
        "version": "1.0.0",
        "variantId": "control",
        "experimentId": null,
      },
  }
---

# Task Decomposer

**Purpose:** Turn a broad goal ("Build a user authentication system", "Launch Q3 SEO sprint", "Migrate to Postgres") into a small number of thin, verifiable vertical slices that can each be implemented and tested in 1–2 agent-hours.

**Who should use this:** Anyone about to hand an agent a large, ambiguous task. Without decomposition, agents tend to either monolith the whole thing (high failure risk) or spawn dozens of micro-tasks (cognitive overload). This skill finds the middle path.

## Invocation

Call this skill via `/task-decomposer` or by asking the assistant to "decompose this task" / "plan vertical slices for X". The skill accepts a goal and two optional tuning parameters:

- **goal** (required, string) — the high-level outcome to decompose
- **depth** (optional, integer 2–5, default 3) — target number of slices
- **risk_level** (optional, `low` | `medium` | `high`, default `medium`) — adjusts how much security, observability, and rollback planning each slice includes

## Output shape

Return **only** a JSON object matching this schema (no prose, no markdown fence):

```json
{
  "goal": "original goal verbatim",
  "depth": 3,
  "risk_level": "medium",
  "slices": [
    {
      "slice_id": "S1",
      "title": "Short imperative title (≤ 60 chars)",
      "end_to_end_scope": "What this slice delivers end-to-end. A single user-visible behavior or measurable business outcome.",
      "acceptance_criteria": [
        "Specific, testable criterion 1",
        "Specific, testable criterion 2"
      ],
      "test_hooks": [
        "Unit: …",
        "Integration: …",
        "Manual smoke: …"
      ],
      "security_considerations": [
        "What new attack surface this slice opens and how it's mitigated"
      ],
      "rollback_plan": "One-sentence description of how to reverse this slice if it goes wrong",
      "est_agent_hours": 1.5,
      "dependencies": ["S0 if any"]
    }
  ],
  "global_risks": [
    "Risks that span more than one slice (data consistency, auth migration, etc.)"
  ],
  "assumptions": [
    "Assumptions the decomposition relies on — surface them so the human can correct before execution"
  ]
}
```

Validation: the produced JSON **must** parse, must pass `schema.json` (same directory), and must satisfy:

- `slices.length === depth` (±1 if the decomposition genuinely needs it — prefer the exact count)
- Each slice delivers something end-to-end. "Set up database schema" is NOT a slice. "User can sign up with email + password verification" IS a slice.
- `est_agent_hours` sums to ≤ 2 × depth. If your decomposition needs more than that, the task is too big for one /task-decomposer call — return a top-level `too_big: true` and suggest a coarser partitioning instead.
- `test_hooks` must include at least one test that can actually run (not "test the whole flow" — specific enough that an agent could write the assertion).
- When `risk_level === "high"`, every slice must include a non-empty `rollback_plan`.

## Rules of thumb

1. **Each slice is a user-visible outcome.** Not a layer, not a file, not a refactor step.
2. **One slice per 1–2 hours.** If a slice is bigger, it's two slices.
3. **Tests come with the slice, not after.** Test hooks are part of the slice definition.
4. **Assumptions go in `assumptions[]`, not buried in prose.** Make them inspectable.
5. **Dependencies must form a DAG.** If S2 depends on S1 and S3 depends on S2, say so in `dependencies[]`. Do not assume ordering is implicit.
6. **Security is a slice attribute, not a phase.** Never return a decomposition where "add auth" is slice 5 of 5.

## Examples

### Goal: "Build a user authentication system" (depth=3, risk=medium)

```json
{
  "goal": "Build a user authentication system",
  "depth": 3,
  "risk_level": "medium",
  "slices": [
    {
      "slice_id": "S1",
      "title": "Email + password signup with verification",
      "end_to_end_scope": "A new user can create an account via email+password, receive a verification link, click it, and reach a logged-in state.",
      "acceptance_criteria": [
        "POST /auth/signup with valid email+password creates a pending_verification user row",
        "Verification email is queued with a single-use token (TTL 24h)",
        "GET /auth/verify?token=... flips pending_verification → active and sets a session cookie",
        "Invalid/expired tokens return 400 without leaking user existence"
      ],
      "test_hooks": [
        "Unit: token generation is unguessable (crypto.randomBytes, not Math.random)",
        "Integration: signup → verification → login round-trip",
        "Security: verification token cannot be reused, cannot be brute-forced (rate-limited 5/min/IP)"
      ],
      "security_considerations": [
        "Passwords stored with argon2id, never plaintext",
        "Verification tokens are single-use and expire in 24h",
        "Signup endpoint is rate-limited per IP to prevent enumeration"
      ],
      "rollback_plan": "Disable the /auth/signup route, delete pending_verification rows, no data loss on rollback",
      "est_agent_hours": 2,
      "dependencies": []
    },
    {
      "slice_id": "S2",
      "title": "Session login + logout",
      "end_to_end_scope": "An existing active user can log in with email+password and log out via a single endpoint each. Sessions persist via HttpOnly+Secure cookie.",
      "acceptance_criteria": [
        "POST /auth/login sets a session cookie on success",
        "POST /auth/logout clears the cookie server-side",
        "Wrong password returns 401 without revealing whether the email exists",
        "Lockout after 10 failed attempts in 15 minutes per email+IP"
      ],
      "test_hooks": [
        "Unit: argon2id verify constant-time",
        "Integration: login → /me → logout → /me returns 401",
        "Security: lockout trigger, timing-attack resistance on wrong-email vs wrong-password"
      ],
      "security_considerations": [
        "Cookies: HttpOnly, Secure, SameSite=Lax",
        "Login responses do not leak email existence (same error + same timing)"
      ],
      "rollback_plan": "Revert /auth/login + /auth/logout routes, force all active sessions to re-authenticate",
      "est_agent_hours": 1.5,
      "dependencies": ["S1"]
    },
    {
      "slice_id": "S3",
      "title": "Password reset via email token",
      "end_to_end_scope": "A user can request a password reset, receive an email, click a single-use link, and set a new password.",
      "acceptance_criteria": [
        "POST /auth/forgot queues a reset email and returns 200 whether the email exists or not",
        "Reset tokens are single-use, expire in 1h, and are invalidated on successful password change",
        "POST /auth/reset requires valid token + new password",
        "Setting a new password invalidates all existing sessions for that user"
      ],
      "test_hooks": [
        "Unit: reset token generation + expiry",
        "Integration: request → email → reset → old password no longer works",
        "Security: cannot reuse a token, cannot use another user's token"
      ],
      "security_considerations": [
        "Forgot endpoint returns identical response for existing and nonexistent emails",
        "Password reset invalidates all sessions — prevents attacker maintaining a pre-reset foothold"
      ],
      "rollback_plan": "Disable /auth/forgot and /auth/reset routes, leave existing hashed passwords intact",
      "est_agent_hours": 1.5,
      "dependencies": ["S1", "S2"]
    }
  ],
  "global_risks": [
    "Email deliverability: verification and reset flows fail silently if SMTP is misconfigured — monitor bounce rate in S1",
    "Session cookie domain scoping: wrong domain makes cookies disappear silently in staging"
  ],
  "assumptions": [
    "An email sending service (SES, Resend, SendGrid, etc.) is already wired up",
    "A user table with at least (id, email UNIQUE, password_hash, status) already exists or is acceptable to create in S1",
    "HTTPS is terminated at the edge so HttpOnly+Secure cookies are viable",
    "There is no existing OAuth/SSO integration to coexist with"
  ]
}
```

## What NOT to do

- **Don't return layered slices.** "Set up models", "build API", "build UI" is a lasagna, not a vertical slice.
- **Don't leave tests for a final "polish" slice.** Tests travel with the slice they validate.
- **Don't invent dependencies.** If two slices can be done in parallel, their `dependencies` arrays should reflect that.
- **Don't exceed `depth`.** If the goal genuinely needs more slices, return `too_big: true` and suggest a coarser framing.
- **Don't speak in hedges.** "Probably", "maybe", "if time permits" are not acceptance criteria. Every criterion must be a pass/fail assertion.

## Telemetry

When this skill is invoked via `/task-decomposer`, the runtime emits a `skill_invocation` event to Quinn-Co marketplace analytics with:
- `skill_id = "task-decomposer"`
- `variant_id` — resolved by the experiment service (defaults to `"control"`)
- `token_cost_usd` — estimated from the response length
- `approved` — null by default; MC can flip to true/false when a reviewer marks the output useful

Future variants (`v2-aggressive-risk`, etc.) will ship as separate skill entries once the RI-014 Phase 2 multi-version-on-disk gap is closed.
