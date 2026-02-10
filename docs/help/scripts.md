---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Repository scripts: purpose, scope, and safety notes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running scripts from the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or changing scripts under ./scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Scripts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `scripts/` directory contains helper scripts for local workflows and ops tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these when a task is clearly tied to a script; otherwise prefer the CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scripts are **optional** unless referenced in docs or release checklists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer CLI surfaces when they exist (example: auth monitoring uses `openclaw models status --check`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Assume scripts are host‑specific; read them before running on a new machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth monitoring scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth monitoring scripts are documented here:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[/automation/auth-monitoring](/automation/auth-monitoring)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When adding scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep scripts focused and documented.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a short entry in the relevant doc (or create one if missing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
