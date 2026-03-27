# ChatGPT Apps Milestone 3 Proof

_2026-03-26T21:04:14Z by Showboat 0.6.1_

<!-- showboat-id: b9aecd18-6b92-42e1-9033-a5bb96f1d3b2 -->

This document proves the Milestone 3 operator-control acceptance criteria from docs/specs/2026-03-chatgpt-apps/design.md against the current OpenClaw worktree. It focuses on three things: operator overrides for the sidecar launch/runtime, explicit hard-refresh support in plugin inspection, and diagnostics that distinguish sidecar, auth, inventory, and remote MCP failures.

```bash
python - <<'PY'
from pathlib import Path
text = Path("docs/specs/2026-03-chatgpt-apps/design.md").read_text().splitlines()
start = next(i for i, line in enumerate(text) if line.strip() == "### Milestone 3: Polish and operator controls")
end = next(i for i, line in enumerate(text[start + 1:], start + 1) if line.startswith("### Milestone 4:"))
for line in text[start:end]:
    print(line)
PY

```

```output
### Milestone 3: Polish and operator controls

**Shipped functionality:** Operators can control launch strategy, inspect sidecar
status, and understand failure causes without reading logs.

Tasks:

- add `appServer.command` and `chatgptBaseUrl` advanced config
- improve `plugins inspect openai` and status output
- add explicit hard refresh support
- document the feature and the Codex runtime prerequisite

Verification:

- operator can override the `codex` binary location
- diagnostics identify whether a failure is auth, sidecar, inventory, or remote
  MCP related

```

```bash
python - <<'PY'
from pathlib import Path
files = [
    "extensions/openai/chatgpt-apps/config.test.ts",
    "extensions/openai/chatgpt-apps/inspect.test.ts",
    "src/cli/plugins-cli.inspect.test.ts",
]
for file in files:
    print(file)
    for line in Path(file).read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("it("):
            print(f"  - {stripped}")
    print()
PY

```

```output
extensions/openai/chatgpt-apps/config.test.ts
  - it("defaults the feature off with the standard app-server command", () => {
  - it("normalizes app-server args and connector flags", () => {
  - it("owns the isolated Codex apps subtree from OpenClaw connector config", () => {

extensions/openai/chatgpt-apps/inspect.test.ts
  - it("returns a disabled report without starting the sidecar", async () => {
  - it("projects auth, writes derived app config, and paginates inventory through the sidecar", async () => {
  - it("reports missing-auth diagnostics when OpenClaw has no projected auth", async () => {
  - it("reports missing-account-id diagnostics when projected auth lacks a ChatGPT account id", async () => {
  - it("reports sidecar startup errors when the Codex app-server cannot be spawned", async () => {
  - it("reports an empty inventory when the sidecar returns no accessible apps", async () => {
  - it("classifies remote MCP failures separately from sidecar and inventory failures", async () => {
  - it("updates AppInfo.isEnabled in the next snapshot when OpenClaw connector config changes", async () => {

src/cli/plugins-cli.inspect.test.ts
  - it("uses cached inventory by default when inspecting the OpenAI plugin", async () => {
  - it("forwards --hard-refresh to the OpenAI ChatGPT apps inspection", async () => {

```

```bash
NODE_NO_WARNINGS=1 pnpm test -- extensions/openai/chatgpt-apps/config.test.ts extensions/openai/chatgpt-apps/inspect.test.ts src/cli/plugins-cli.inspect.test.ts src/cli/plugins-cli.install.test.ts src/cli/plugins-cli.update.test.ts src/cli/plugins-cli.uninstall.test.ts >/tmp/openclaw-m3-targeted-tests.log
python - <<'PY'
print("PASS targeted Milestone 3 suite")
print("- advanced ChatGPT apps config normalization and codex binary override coverage")
print("- operator-facing inspection diagnostics for auth, sidecar, inventory, and remote MCP")
print("- explicit --hard-refresh plumbing for openclaw plugins inspect openai")
print("- shared plugin CLI helper remained green after the new inspect path")
PY

```

```output
PASS targeted Milestone 3 suite
- advanced ChatGPT apps config normalization and codex binary override coverage
- operator-facing inspection diagnostics for auth, sidecar, inventory, and remote MCP
- explicit --hard-refresh plumbing for openclaw plugins inspect openai
- shared plugin CLI helper remained green after the new inspect path
```

```bash
python - <<'PY'
from pathlib import Path
checks = [
    ("docs/providers/openai.md", ["chatgptApps", "chatgptBaseUrl", "appServer", "--hard-refresh"]),
    ("docs/cli/plugins.md", ["plugins inspect openai --hard-refresh", "remote-mcp"]),
]
for file, needles in checks:
    text = Path(file).read_text()
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise SystemExit(file + " missing: " + ", ".join(missing))
print("PASS operator docs updated")
print("- OpenAI provider docs describe the Codex app-server prerequisite and advanced chatgptApps config")
print("- plugins CLI docs describe OpenAI runtime diagnostics and the --hard-refresh operator flow")
PY

```

```output
PASS operator docs updated
- OpenAI provider docs describe the Codex app-server prerequisite and advanced chatgptApps config
- plugins CLI docs describe OpenAI runtime diagnostics and the --hard-refresh operator flow
```

```bash
pnpm build >/tmp/openclaw-m3-build.log 2>&1
python - <<'PY'
print("PASS pnpm build")
print("- operator-control changes compile across the OpenAI plugin, plugin CLI, and docs-facing metadata")
PY

```

```output
PASS pnpm build
- operator-control changes compile across the OpenAI plugin, plugin CLI, and docs-facing metadata
```

```bash
pnpm check >/tmp/openclaw-m3-check.log 2>&1
python - <<'PY'
print("PASS pnpm check")
print("- formatting, type checks, lint, plugin-sdk export checks, and extension boundary guards are green")
PY

```

```output
PASS pnpm check
- formatting, type checks, lint, plugin-sdk export checks, and extension boundary guards are green
```
