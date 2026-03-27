# ChatGPT Apps Milestone 2 Proof

_2026-03-26T20:47:24Z by Showboat 0.6.1_

<!-- showboat-id: 1fab9dc5-c2bd-4863-9618-bb1c4829e160 -->

This document proves the Milestone 2 acceptance criteria from `docs/specs/2026-03-chatgpt-apps/design.md` against the current OpenClaw worktree.

The proof is criterion-oriented:

- extract the Milestone 2 shipped functionality and verification bullets from the design doc
- show the bridge-focused test names that map directly onto those criteria
- rerun the targeted milestone suite, `pnpm build`, `pnpm plugin-sdk:api:check`, and `pnpm check` with deterministic summaries

```bash
python - <<'PY'
from pathlib import Path
files = [
    "extensions/openai/chatgpt-apps/mcp-bridge.test.ts",
    "src/agents/embedded-pi-mcp.managed.test.ts",
    "src/agents/cli-runner/bundle-mcp.test.ts",
    "src/cli/mcp-cli.test.ts",
    "extensions/openai/index.test.ts",
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
extensions/openai/chatgpt-apps/mcp-bridge.test.ts
  - it("matches the Codex apps endpoint derivation rules", () => {
  - it("exposes only accessible and enabled connector tools and forwards calls", async () => {

src/agents/embedded-pi-mcp.managed.test.ts
  - it("merges managed MCP servers before top-level configured MCP servers", () => {
  - it("lets top-level configured MCP servers override managed registrations", () => {

src/agents/cli-runner/bundle-mcp.test.ts
  - it("injects a merged --mcp-config overlay for claude-cli", async () => {
  - it("includes managed MCP servers in the generated claude-cli overlay", async () => {

src/cli/mcp-cli.test.ts
  - it("sets and shows a configured MCP server", async () => {
  - it("fails when removing an unknown MCP server", async () => {
  - it("runs the internal OpenAI ChatGPT apps bridge entrypoint", async () => {

extensions/openai/index.test.ts
  - it("registers the expected provider surfaces", () => {
  - it("registers the ChatGPT apps service and managed MCP bridge when enabled", () => {
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
NODE_NO_WARNINGS=1 pnpm test -- extensions/openai/chatgpt-apps/mcp-bridge.test.ts extensions/openai/index.test.ts src/cli/mcp-cli.test.ts src/agents/embedded-pi-mcp.managed.test.ts src/agents/cli-runner/bundle-mcp.test.ts >/tmp/openclaw-m2-targeted-tests.log
python - <<'PY'
print("PASS targeted Milestone 2 suite")
print("- bridge filtering and tool forwarding")
print("- managed MCP injection for embedded Pi")
print("- managed MCP injection for CLI backends")
print("- internal CLI bridge entrypoint")
print("- OpenAI plugin bridge registration")
PY

```

```output
PASS targeted Milestone 2 suite
- bridge filtering and tool forwarding
- managed MCP injection for embedded Pi
- managed MCP injection for CLI backends
- internal CLI bridge entrypoint
- OpenAI plugin bridge registration
```

```bash
pnpm build >/tmp/openclaw-m2-build.log 2>&1
python - <<'PY'
print("PASS pnpm build")
print("- bridge sources compile into the repo build outputs")
print("- managed MCP registration stays compatible with production build tooling")
PY

```

```output
PASS pnpm build
- bridge sources compile into the repo build outputs
- managed MCP registration stays compatible with production build tooling
```

```bash
pnpm plugin-sdk:api:check >/tmp/openclaw-m2-plugin-sdk.log 2>&1
python - <<'PY'
print("PASS pnpm plugin-sdk:api:check")
print("- the managed MCP registration surface matches the recorded Plugin SDK baseline")
PY

```

```output
PASS pnpm plugin-sdk:api:check
- the managed MCP registration surface matches the recorded Plugin SDK baseline
```

```bash
pnpm check >/tmp/openclaw-m2-check.log 2>&1
python - <<'PY'
print("PASS pnpm check")
print("- formatting, typecheck, lint, plugin-sdk export checks, and extension boundary guards are green")
PY

```

```output
PASS pnpm check
- formatting, typecheck, lint, plugin-sdk export checks, and extension boundary guards are green
```
