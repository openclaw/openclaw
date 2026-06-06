# Webwright setup

Webwright is a Python CLI (Python 3.10+) that drives Chromium via Playwright.

## Install the CLI

Webwright is distributed from source (MIT, https://github.com/microsoft/webwright):

```bash
git clone https://github.com/microsoft/webwright
cd webwright
python3 -m venv .venv && source .venv/bin/activate   # recommended: isolate the install
pip install -e .
playwright install chromium
```

After install, the `webwright` console command is available. Confirm the setup:

```bash
webwright doctor
```

> Environment gotcha: webwright runs the agent's generated scripts in a shell
> subprocess and they call `python`/`python3`/`playwright` from `PATH`. Make sure
> the install above is the one on `PATH` when you run a task (activate the venv,
> or prepend its `bin` to `PATH`). Otherwise generated scripts may use a different
> system Python that has no Chromium, and the browser launch fails.

## Provider API keys

Set the key matching the model config you pass with `-c`:

- OpenAI configs: `export OPENAI_API_KEY=...`
- Anthropic configs: `export ANTHROPIC_API_KEY=...`
- OpenRouter configs: `export OPENROUTER_API_KEY=...`

## Config files

Webwright reads stackable YAML config files via repeated `-c` flags. A typical run
stacks a base config with a model config:

```bash
webwright main -c base.yaml -c model_openai.yaml ...
```

The webwright repo ships builtin configs (e.g. `base.yaml`, `model_openai.yaml`,
`model_claude.yaml`, `model_openrouter.yaml`). Reference them by name, copy and
edit them, or keep project-specific configs in your workspace. Later `-c` specs
override earlier ones, and a `key=value` spec applies an inline override.

## Enable the skill

This bundled skill is opt-in: it stays hidden from the model until you enable it
(an unset `skills.entries.webwright.enabled` counts as off):

```bash
openclaw config set skills.entries.webwright.enabled true
```

## Requirements summary

- `skills.entries.webwright.enabled: true` (the opt-in above)
- Python >= 3.10
- Playwright >= 1.45 with Chromium (`playwright install chromium`)
- A provider API key in the environment
