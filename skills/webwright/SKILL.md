---
name: webwright
description: "Run long-horizon, multi-step browser automation by delegating to the Microsoft webwright CLI, which writes and executes Playwright scripts to drive a real Chromium browser. Use for logins, multi-page forms, checkout/wizard flows, and repeatable site navigation; not for simple single-page reads."
homepage: https://github.com/microsoft/webwright
license: MIT
metadata:
  {
    "openclaw":
      {
        "emoji": "🕸️",
        "requires": { "bins": ["webwright"], "config": ["skills.entries.webwright.enabled"] },
        "os": ["darwin", "linux"],
      },
  }
---

# Webwright

Delegate browser tasks to the `webwright` CLI. Webwright is a code-as-action web
agent: an LLM writes and runs Playwright scripts to drive a real Chromium browser,
which is more robust and repeatable than click-by-click automation.

## When to use

- Multi-step web flows: logins, multi-page forms, checkout/wizard flows.
- Long-horizon navigation across several pages where state must be carried.
- Repeatable site tasks where you want a reusable generated script as the artifact.

## When NOT to use

- Simple single-page reads or extraction — use `web_fetch` / built-in web tools.
- Anything that does not actually require a driven browser.

## Preflight (do this before the first run)

Run `webwright doctor` first — it checks Python, Playwright, Chromium, the
provider key, and plugins in one shot. Then confirm:

1. `webwright` is on PATH (this skill is gated on it). If missing, see
   `references/setup.md`.
2. Chromium is installed for Playwright: `playwright install chromium`.
3. A provider API key is set in the environment for the model config you pick:
   `OPENAI_API_KEY` (default `model_openai.yaml`), `ANTHROPIC_API_KEY`
   (`model_claude.yaml`), or `OPENROUTER_API_KEY` (`model_openrouter.yaml`).
4. The `python`, `python3`, and `playwright` that webwright's generated scripts
   will invoke must be webwright's own install (with Chromium). If you installed
   webwright in a venv, activate it (or prepend its `bin` to `PATH`) before
   running — otherwise generated scripts can pick up a different system Python
   that lacks the browser. See `references/setup.md`.
5. Choose an output directory INSIDE the current workspace. Never write into
   `~/.openclaw`, `$OPENCLAW_STATE_DIR`, or any active OpenClaw state directory.

## Invocation

The CLI uses a `main` subcommand:

```bash
webwright main \
  -t "TASK INSTRUCTION" \
  --start-url "https://example.com" \
  -c base.yaml -c model_openai.yaml \
  --task-id my_task \
  -o ./webwright-out/my_task
```

`-c` defaults to `base.yaml model_openai.yaml`. You can also stack inline
overrides, e.g. `-c agent.step_limit=20` to cap the agent's step budget.

Then read the run artifacts (generated `final_script.py`, `plan.md`, step logs,
screenshots under `final_runs/run_<id>/`) from the `-o` directory and report the
generated script path to the user.

See `references/cli.md` for every flag, config stacking, and the output layout.

## Hard rules

- Always pass `-o` pointing inside the workspace; never inside OpenClaw state dirs.
- Always pass `--start-url` and a specific, scoped `-t` task.
- Browser runs take real actions on live sites and spend API tokens. Only run on
  user-authorized tasks and sites. Do not perform destructive actions or submit
  credentials unless the user explicitly provided them for this task.
- Pick exactly one model config (`model_openai.yaml`, `model_claude.yaml`,
  `model_openrouter.yaml`) whose matching API key is present in the environment.

## Examples

Search flights and read the results:

```bash
webwright main -t "Search flights SEA to JFK departing 2026-08-15 returning 2026-08-20" \
  --start-url "https://www.google.com/flights" \
  -c base.yaml -c model_openai.yaml --task-id flights -o ./webwright-out/flights
```

Extract a table behind a multi-step navigation (Claude model):

```bash
webwright main -t "Open the docs, go to the pricing page, and list every plan and price" \
  --start-url "https://example.com" \
  -c base.yaml -c model_claude.yaml --task-id pricing -o ./webwright-out/pricing
```
