---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: oracle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Best practices for using the oracle CLI (prompt + file bundling, engines, sessions, and file attachment patterns).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://askoracle.dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🧿",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["oracle"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "package": "@steipete/oracle",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["oracle"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install oracle (node)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# oracle — best use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat output as advisory: verify against code + tests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Main use case (browser, GPT‑5.2 Pro)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default workflow here: `--engine browser` with GPT‑5.2 Pro in ChatGPT. This is the common “long think” path: ~10 minutes to ~1 hour is normal; expect a stored session you can reattach to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Engine: browser (`--engine browser`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model: GPT‑5.2 Pro (`--model gpt-5.2-pro` or `--model "5.2 Pro"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Golden path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Pick a tight file set (fewest files that still contain the truth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Preview payload + token spend (`--dry-run` + `--files-report`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Use browser mode for the usual GPT‑5.2 Pro workflow; use API only when you explicitly want it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If the run detaches/timeouts: reattach to the stored session (don’t re-run).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands (preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Help:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --help`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If the binary isn’t installed: `npx -y @steipete/oracle --help` (avoid `pnpx` here; sqlite bindings).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preview (no tokens):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --dry-run full -p "<task>" --file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token sanity:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --dry-run summary --files-report -p "<task>" --file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser run (main path; long-running is normal):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --engine browser --model gpt-5.2-pro -p "<task>" --file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual paste fallback:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `oracle --render --copy -p "<task>" --file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Note: `--copy` is a hidden alias for `--copy-markdown`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Attaching files (`--file`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--file src/index.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--file docs --file README.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exclude:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Defaults (implementation behavior):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless explicitly passed as literal dirs/files).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Honors `.gitignore` when expanding globs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Does not follow symlinks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Dotfiles filtered unless opted in via pattern (e.g. `--file ".github/**"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Files > 1 MB rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Engines (API vs browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-pick: `api` when `OPENAI_API_KEY` is set; otherwise `browser`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser attachments:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote browser host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions + slugs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs may detach or take a long time (browser + GPT‑5.2 Pro often does). If the CLI times out: don’t re-run; reattach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - List: `oracle status --hours 72`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Attach: `oracle session <id> --render`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--slug "<3-5 words>"` to keep session IDs readable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prompt template (high signal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Project briefing (stack + build/test commands + platform constraints).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Where things live” (key directories, entrypoints, config files, boundaries).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exact question + what you tried + the error text (verbatim).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Constraints (“don’t change X”, “must keep public API”, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Desired output (“return patch plan + tests”, “give 3 options with tradeoffs”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## “Exhaustive prompt” restoration pattern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For long investigations, write a standalone prompt + file set so you can rerun days later:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 6–30 sentence project briefing + the goal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repro steps + exact errors + what you tried.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attach all context files needed (entrypoints, configs, key modules, docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Oracle runs are one-shot; the model doesn’t remember prior runs. “Restoring context” means re-running with the same prompt + `--file …` set (or reattaching a still-running stored session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
