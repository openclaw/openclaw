# Playwright CLI — Browser Automation for Coding Agents

## Principle

When an AI agent needs to look at a webpage — take a snapshot, grab selectors, capture a screenshot — it shouldn't have to load thousands of tokens of DOM trees and tool schemas into its context window just to do that. Playwright CLI gives the agent a lightweight way to talk to a browser through simple shell commands, keeping the context window free for reasoning and code generation.

## Rationale

Playwright MCP is powerful, but it's heavy. Every interaction loads full accessibility trees and tool definitions into the LLM context. That's fine for complex, stateful flows where you need rich introspection. But for the common case — "open this page, tell me what's on it, take a screenshot" — it's overkill.

Playwright CLI solves this by returning concise **element references** (`e15`, `e21`) instead of full DOM dumps. The result: ~93% fewer tokens per interaction, which means the agent can run longer sessions, reason more deeply, and still have context left for your actual code.

**The trade-off is simple:**

- **CLI** = fast, lightweight, stateless — great for quick looks at pages
- **MCP** = rich, stateful, full-featured — great for complex multi-step automation

TEA uses both where each shines (see `tea_browser_automation: "auto"`).

## Prerequisites

```bash
npm install -g @playwright/cli@latest    # Install globally (Node.js 18+)
playwright-cli install --skills          # Register as an agent skill
```

The global npm install is one-time. Run `playwright-cli install --skills` from your project root to register skills in `.claude/skills/` (works with Claude Code, GitHub Copilot, and other coding agents). Agents without skills support can use the CLI directly via `playwright-cli --help`. TEA documents this during installation but does not run it for you.

## How It Works

The agent interacts with the browser through shell commands. Each command is a single, focused action:

```bash
# 1. Open a page
playwright-cli -s=tea-explore open https://app.com/login

# 2. Take a snapshot — returns element references, not DOM trees
playwright-cli -s=tea-explore snapshot
# Output: [{ref: "e15", role: "textbox", name: "Email"},
#          {ref: "e21", role: "textbox", name: "Password"},
#          {ref: "e33", role: "button", name: "Sign In"}]

# 3. Interact using those references
playwright-cli -s=tea-explore fill e15 "user@example.com"
playwright-cli -s=tea-explore fill e21 "password123"
playwright-cli -s=tea-explore click e33

# 4. Capture evidence
playwright-cli -s=tea-explore screenshot --filename=login-flow.png

# 5. Clean up
playwright-cli -s=tea-explore close
```

The `-s=tea-explore` flag scopes everything to a named session, preventing state leakage between workflows.

## What TEA Uses It For

**Selector verification** — Before generating test code, TEA can snapshot a page to see the actual labels, roles, and names of elements. Instead of guessing that a button says "Login", it knows it says "Sign In":

```
snapshot ref {role: "button", name: "Sign In"}
  → generates: page.getByRole('button', { name: 'Sign In' })
```

**Page discovery** — During `test-design` exploratory mode, TEA snapshots pages to understand what's actually there, rather than relying only on documentation.

**Evidence collection** — During `test-review`, TEA can capture screenshots, traces, and network logs as evidence without the overhead of a full MCP session.

## How CLI Relates to Playwright Utils and API Testing

CLI and playwright-utils are **complementary tools that work at different layers**:

|              | Playwright CLI                               | Playwright Utils                                 |
| ------------ | -------------------------------------------- | ------------------------------------------------ |
| **When**     | During test _generation_ (the agent uses it) | During test _execution_ (your test code uses it) |
| **What**     | Shell commands to observe your app           | Fixtures and helpers imported in test files      |
| **Examples** | `snapshot`, `screenshot`, `network`          | `apiRequest`, `auth-session`, `network-recorder` |

They work together naturally. The agent uses CLI to _understand_ your app, then generates test code that _imports_ playwright-utils:

```bash
# Agent uses CLI to observe network traffic on the dashboard page
playwright-cli -s=tea-discover open https://app.com/dashboard
playwright-cli -s=tea-discover network
# Output: GET /api/users → 200, POST /api/audit → 201, GET /api/settings → 200
playwright-cli -s=tea-discover close
```

```typescript
// Agent generates API tests using what it discovered, with playwright-utils
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";

test("GET /api/users returns user list", async ({ apiRequest }) => {
  const { status, body } = await apiRequest<User[]>({
    method: "GET",
    path: "/api/users",
  });
  expect(status).toBe(200);
  expect(body.length).toBeGreaterThan(0);
});
```

**For pure API testing** (no UI involved), CLI doesn't add much — there's no page to snapshot. The agent generates API tests directly from documentation, specs, or code analysis using `apiRequest` and `recurse` from playwright-utils.

**For E2E testing**, CLI shines — it snapshots the page to get accurate selectors, observes network calls to understand the API contract, and captures auth flows via `state-save` that inform how tests use `auth-session`.

**Bottom line:** CLI helps the agent _write better tests_. Playwright-utils helps those tests _run reliably_.

## Session Isolation

Every CLI command targets a named session. This prevents workflows from interfering with each other:

```bash
# Workflow A uses one session
playwright-cli -s=tea-explore open https://app.com

# Workflow B uses a different session (can run in parallel)
playwright-cli -s=tea-verify open https://app.com/admin
```

For parallel safety (multiple agents on the same machine), append a unique suffix:

```bash
playwright-cli -s=tea-explore-<timestamp> open https://app.com
```

## Command Quick Reference

| What you want to do       | Command                                          |
| ------------------------- | ------------------------------------------------ |
| Open a page               | `open <url>`                                     |
| See what's on the page    | `snapshot`                                       |
| Take a screenshot         | `screenshot [--filename=path]`                   |
| Click something           | `click <ref>`                                    |
| Type into a field         | `fill <ref> <text>`                              |
| Navigate                  | `goto <url>`, `go-back`, `reload`                |
| Mock a network request    | `route <pattern> --status=200 --body='...'`      |
| Start recording a trace   | `tracing-start`                                  |
| Stop and save the trace   | `tracing-stop`                                   |
| Save auth state for reuse | `state-save auth.json`                           |
| Load saved auth state     | `state-load auth.json`                           |
| See network requests      | `network`                                        |
| Manage tabs               | `tab-list`, `tab-new`, `tab-close`, `tab-select` |
| Close the session         | `close`                                          |

## When CLI vs MCP (Auto Mode Decision)

| Situation                             | Tool | Why                                |
| ------------------------------------- | ---- | ---------------------------------- |
| "What's on this page?"                | CLI  | One-shot snapshot, no state needed |
| "Verify this selector exists"         | CLI  | Single check, minimal tokens       |
| "Capture a screenshot for evidence"   | CLI  | Stateless capture                  |
| "Walk through a multi-step wizard"    | MCP  | State carries across steps         |
| "Debug why this test fails" (healing) | MCP  | Needs rich DOM introspection       |
| "Record a drag-and-drop flow"         | MCP  | Complex interaction semantics      |

## Related Fragments

- `overview.md` — Playwright Utils installation and fixture patterns (the test code layer that CLI complements)
- `api-request.md` — Typed HTTP client for API tests (CLI discovers endpoints, apiRequest tests them)
- `api-testing-patterns.md` — Pure API test patterns (when CLI isn't needed)
- `auth-session.md` — Token management (CLI `state-save` informs auth-session usage)
- `selector-resilience.md` — Robust selector strategies (CLI verifies them against real DOM)
- `visual-debugging.md` — Trace viewer usage (CLI captures traces)
