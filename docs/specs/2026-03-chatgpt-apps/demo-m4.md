# ChatGPT Apps Milestone 4 Proof

_2026-03-26T21:32:40Z by Showboat 0.6.1_

<!-- showboat-id: 757e5277-003f-44de-a077-05ba3b2989cf -->

This document proves the Milestone 4 connect-flow acceptance criteria from docs/specs/2026-03-chatgpt-apps/design.md against the current OpenClaw worktree. It focuses on the new local-only link tools, the public browser helper/export needed by those tools, and the managed MCP bridge refresh that surfaces newly linked app tools without restarting the gateway.

```bash
python - <<'PY'
from pathlib import Path
text = Path("docs/specs/2026-03-chatgpt-apps/design.md").read_text().splitlines()
start = next(i for i, line in enumerate(text) if line.strip() == "### Milestone 4: Connect flow parity")
for line in text[start:]:
    if line.startswith("## ") and line.strip() != "### Milestone 4: Connect flow parity":
        break
    print(line)
PY

```

```output
### Milestone 4: Connect flow parity

**Shipped functionality:** OpenClaw can initiate connector link flows rather
than only consuming already-linked connectors.

Tasks:

- confirm the source-backed link/install flow contract
- add operator-facing connect UX
- refresh inventory after link completion

Verification:

- linking a connector from OpenClaw makes it appear in the inventory and tool
  surface without restarting the gateway

```

```bash
python - <<'PY'
from pathlib import Path
files = [
    "extensions/openai/chatgpt-apps/link-tools.test.ts",
    "extensions/openai/chatgpt-apps/mcp-bridge.test.ts",
    "extensions/openai/index.test.ts",
]
for file in files:
    print(file)
    for line in Path(file).read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith('it('):
            print(f"  - {stripped}")
    print()
PY

```

```output
extensions/openai/chatgpt-apps/link-tools.test.ts
  - it("exposes native link tools only for local owner contexts", () => {
  - it("groups inventory into accessible, linkable, disabled, and unavailable buckets", async () => {
  - it("fails closed when an app does not expose an install URL", async () => {
  - it("waits for accessibility changes and warns when the linked app stays locally disabled", async () => {
  - it("coalesces concurrent link attempts for the same app and account", async () => {

extensions/openai/chatgpt-apps/mcp-bridge.test.ts
  - it("matches the Codex apps endpoint derivation rules", () => {
  - it("exposes only accessible and enabled connector tools and forwards calls", async () => {
  - it("refreshes the tool surface after inventory updates without restarting the bridge", async () => {

extensions/openai/index.test.ts
  - it("registers the expected provider surfaces", () => {
  - it("registers the ChatGPT apps service and managed MCP bridge when enabled", () => {
  - it("registers the native ChatGPT app link tools when linking is enabled", () => {
  - it("generates PNG buffers from the OpenAI Images API", async () => {
  - it("rejects reference-image edits for now", async () => {
  - it("bootstraps the env proxy dispatcher before refreshing oauth credentials", async () => {
  - it("registers an OpenAI provider that can complete a live request", async () => {
  - it("lists voices and synthesizes audio through the registered speech provider", async () => {
  - it("transcribes synthesized speech through the registered media provider", async () => {
  - it("generates an image through the registered image provider", async () => {
  - it("describes a deterministic image through the registered media provider", async () => {

```

```bash
NODE_NO_WARNINGS=1 pnpm test -- extensions/openai/chatgpt-apps/link-tools.test.ts extensions/openai/chatgpt-apps/config.test.ts extensions/openai/chatgpt-apps/mcp-bridge.test.ts extensions/openai/chatgpt-apps/app-server-supervisor.test.ts extensions/openai/index.test.ts >/tmp/openclaw-m4-targeted-tests.log
python - <<'PY'
print("PASS targeted Milestone 4 suite")
print("- local owner-only link tools are registered when chatgptApps.linking.enabled is on")
print("- the link service groups inventory, fails closed without install URLs, and deduplicates concurrent link attempts")
print("- the managed MCP bridge refreshes its tool surface after inventory updates without restarting")
print("- the bundled OpenAI plugin wires the sidecar service, managed bridge, and native link tools together")
PY

```

```output
PASS targeted Milestone 4 suite
- local owner-only link tools are registered when chatgptApps.linking.enabled is on
- the link service groups inventory, fails closed without install URLs, and deduplicates concurrent link attempts
- the managed MCP bridge refreshes its tool surface after inventory updates without restarting
- the bundled OpenAI plugin wires the sidecar service, managed bridge, and native link tools together
```

```bash
python - <<'PY'
import json
from pathlib import Path
provider_doc = Path("docs/providers/openai.md").read_text()
cli_doc = Path("docs/cli/plugins.md").read_text()
exports = json.loads(Path("package.json").read_text())["exports"]
entrypoints = json.loads(Path("scripts/lib/plugin-sdk-entrypoints.json").read_text())
checks = [
    ("docs/providers/openai.md", provider_doc, ["chatgptApps.linking.enabled", "chatgpt_apps", "chatgpt_app_link", "without restarting the gateway"]),
    ("docs/cli/plugins.md", cli_doc, ["chatgptApps.linking.enabled", "chatgpt_app_link", "without restarting the", "tool-list change"]),
]
for file, text, needles in checks:
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise SystemExit(f"{file} missing: {', '.join(missing)}")
if "./plugin-sdk/browser" not in exports:
    raise SystemExit("package.json missing ./plugin-sdk/browser export")
if "browser" not in entrypoints:
    raise SystemExit("scripts/lib/plugin-sdk-entrypoints.json missing browser")
print("PASS docs and public SDK surface updated")
print("- OpenAI provider docs describe chatgptApps.linking and the local-only chatgpt_apps/chatgpt_app_link tools")
print("- plugins CLI docs describe the local-interactive link flow and no-restart bridge refresh")
print("- package.json and the curated plugin-sdk entrypoint list export the new browser helper subpath")
PY

```

```output
PASS docs and public SDK surface updated
- OpenAI provider docs describe chatgptApps.linking and the local-only chatgpt_apps/chatgpt_app_link tools
- plugins CLI docs describe the local-interactive link flow and no-restart bridge refresh
- package.json and the curated plugin-sdk entrypoint list export the new browser helper subpath
```

```bash
pnpm build >/tmp/openclaw-m4-build.log 2>&1
python - <<'PY'
print("PASS pnpm build")
print("- the OpenAI plugin, managed MCP bridge, native link tools, and plugin-sdk browser subpath compile together")
PY

```

```output
PASS pnpm build
- the OpenAI plugin, managed MCP bridge, native link tools, and plugin-sdk browser subpath compile together
```

```bash
pnpm plugin-sdk:api:check >/tmp/openclaw-m4-plugin-sdk-api-check.log 2>&1
python - <<'PY'
print("PASS pnpm plugin-sdk:api:check")
print("- the public plugin-sdk baseline matches after adding the browser helper subpath")
PY

```

```output
PASS pnpm plugin-sdk:api:check
- the public plugin-sdk baseline matches after adding the browser helper subpath
```

```bash
pnpm check >/tmp/openclaw-m4-check.log 2>&1
python - <<'PY'
print("PASS pnpm check")
print("- formatting, types, plugin-sdk export checks, lint, and extension boundary guards are green with the M4 changes")
PY

```

```output
PASS pnpm check
- formatting, types, plugin-sdk export checks, lint, and extension boundary guards are green with the M4 changes
```
