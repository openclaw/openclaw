# Webwright CLI reference

Commands:

- `webwright doctor` — validate the local setup (Python, Playwright, Chromium,
  provider key, plugins). Run this first.
- `webwright main [OPTIONS]` — run a task. This is the command the skill uses.

## `webwright main` flags

| Flag                 | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `-t`, `--task`       | The natural-language task instruction (quote it). Required.         |
| `--start-url`        | The URL the browser opens first.                                    |
| `--task-id`          | A short id used in the output directory name.                       |
| `-c`, `--config`     | Config spec. Repeatable; later specs override earlier.              |
| `-o`, `--output-dir` | Output directory for run artifacts. Keep this inside the workspace. |
| `--debug`            | Launch a headed browser with devtools and keep it open.             |

`-c` defaults to `base.yaml model_openai.yaml`. Run `webwright main --help` for
the full, version-specific flag list.

## Config stacking and inline overrides

A `-c` spec is resolved as a file path, then as a builtin config name (e.g.
`base.yaml`), and otherwise as an inline `key=value` override (dotted keys nest).

```bash
# base + model + an inline override that caps the agent step budget
webwright main -c base.yaml -c model_openai.yaml -c agent.step_limit=20 \
  -t "..." --start-url "..." -o ./out
```

Pick exactly one model config (`model_openai.yaml`, `model_claude.yaml`, or
`model_openrouter.yaml`) and ensure its provider API key is exported.

## Output artifacts

Webwright writes run artifacts into the `-o` directory, including the generated
Python/Playwright script (the durable, reusable "code-as-action" output), run logs,
and any screenshots captured for page inspection. After a run:

1. Report the generated script path to the user.
2. Summarize the result from the logs / final output in the directory.
3. The generated script can be re-run or adapted for repeatable automation.

## Secrets

Never place credentials or tokens in the `-t` task text or in a config file.
Webwright sends the task to the model provider and records run artifacts
(trajectories, logs, process args), so anything in `-t` is exposed. For
login-walled tasks, export credentials as environment variables and instruct the
agent (in the task) to read them by NAME inside its generated script — e.g.
"log in with the values in $SITE_USER and $SITE_PASS" — or pre-authenticate a
persistent browser profile. Never pass the literal secret values.

## Troubleshooting

- `webwright: command not found` → not installed; see `setup.md`.
- Browser fails to launch / missing Chromium → run `playwright install chromium`.
- `webwright doctor` shows `OpenAI Key FAIL` but you use Anthropic/OpenRouter →
  expected. doctor's key check is OpenAI-only; verify your chosen provider's key
  is exported instead.
- Auth/401 from the model → the provider API key for the chosen `-c` model config
  is missing or wrong.
- Task stalls on a login wall → webwright will not invent credentials; provide
  them via environment variable names (see Secrets), only when the user authorized it.
