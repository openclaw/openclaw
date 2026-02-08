# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Project Structure & Module Organization

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).
  - Core channel docs: `docs/channels/`
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`
  - Extensions (channel plugins): `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- When adding channels/extensions/apps/docs, review `.github/labeler.yml` for label coverage.

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

## Docs i18n (zh-CN)

- `docs/zh-CN/**` is generated; do not edit unless the user explicitly asks.
- Pipeline: update English docs → adjust glossary (`docs/.i18n/glossary.zh-CN.json`) → run `scripts/docs-i18n` → apply targeted fixes only if instructed.
- Translation memory: `docs/.i18n/zh-CN.tm.jsonl` (generated).
- See `docs/.i18n/README.md`.
- The pipeline can be slow/inefficient; if it’s dragging, ping @jospalmbier on Discord instead of hacking around it.

## exe.dev VM ops (general)

- Access: stable path is `ssh exe.dev` then `ssh vm-name` (assume SSH key already set).
- SSH flaky: use exe.dev web terminal or Shelley (web agent); keep a tmux session for long ops.
- Update: `sudo npm i -g openclaw@latest` (global install needs root on `/usr/lib/node_modules`).
- Config: use `openclaw config set ...`; ensure `gateway.mode=local` is set.
- Discord: store raw token only (no `DISCORD_BOT_TOKEN=` prefix).
- Restart: stop old gateway and run:
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`.

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- Pre-commit hooks: `prek install` (runs same checks as CI)
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch. Release checklist: `docs/platforms/mac/release.md`.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.
- Naming: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, and config keys.

## Release Channels (Naming)

- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).
- dev: moving head on `main` (no tag; git checkout main).

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what’s covered: `docs/testing.md`.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

## Commit & Pull Request Guidelines

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Changelog workflow: keep latest released version at top (no `Unreleased`); after publishing, bump version and start a new top section.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.
- Read this when submitting a PR: `docs/help/submitting-a-pr.md` ([Submitting a PR](https://docs.openclaw.ai/help/submitting-a-pr))
- Read this when submitting an issue: `docs/help/submitting-an-issue.md` ([Submitting an Issue](https://docs.openclaw.ai/help/submitting-an-issue))
- PR review flow: when given a PR link, review via `gh pr view`/`gh pr diff` and do **not** change branches.
- PR review calls: prefer a single `gh pr view --json ...` to batch metadata/comments; run `gh pr diff` only when needed.
- Before starting a review when a GH Issue/PR is pasted: run `git pull`; if there are local changes or unpushed commits, stop and alert the user before reviewing.
- Goal: merge PRs. Prefer **rebase** when commits are clean; **squash** when history is messy.
- PR merge flow: create a temp branch from `main`, merge the PR branch into it (prefer squash unless commit history is important; use rebase/merge when it is). Always try to merge the PR unless it’s truly difficult, then use another approach. If we squash, add the PR author as a co-contributor. Apply fixes, add changelog entry (include PR # + thanks), run full gate before the final commit, commit, merge back to `main`, delete the temp branch, and end on `main`.
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.
- When working on a PR: add a changelog entry with the PR number and thank the contributor.
- When working on an issue: reference the issue in the changelog entry.
- When merging a PR: leave a PR comment that explains exactly what we did and include the SHA hashes.
- When merging a PR from a new contributor: add their avatar to the README “Thanks to all clawtributors” thumbnail list.
- After merging a PR: run `bun scripts/update-clawtributors.ts` if the contributor is missing, then commit the regenerated README.

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

### PR Workflow (Review vs Land)

- **Review mode (PR link only):** read `gh pr view/diff`; **do not** switch branches; **do not** change code.
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!

## Custom API Endpoints

支持通过环境变量配置自定义 API 端点，用于兼容 Anthropic Messages API 的第三方服务。

### ANTHROPIC_BASE_URL

```bash
export ANTHROPIC_BASE_URL="http://your-custom-endpoint:8045"
export ANTHROPIC_API_KEY="your-api-key"
pnpm openclaw agent --message "Hello" --local
```

**实现位置**: `src/agents/model-compat.ts`

**调用链路**:
```
CLI/Gateway → model-auth.ts (认证) → pi-embedded-runner → normalizeModelCompat() → @mariozechner/pi-ai → Anthropic SDK
```

**关键逻辑** (`normalizeModelCompat` 函数):
1. 检测 `model.provider === "anthropic"`
2. 读取 `process.env.ANTHROPIC_BASE_URL`
3. 当环境变量设置且 model.baseUrl 为空或为默认值时，注入自定义 baseUrl
4. 显式配置的自定义 baseUrl（非默认值）不会被覆盖

**测试**: `src/agents/model-compat.test.ts` 包含 6 个测试用例覆盖各种场景。

**扩展其他 Provider**: 参考 `resolveAnthropicBaseUrl()` 模式，在 `normalizeModelCompat()` 中添加类似逻辑。

## Docker 部署

项目支持 Docker 部署，适合迁移到服务器或 Mac Mini 长期运行。

### 快速部署

```bash
# 1. 构建镜像
docker build -t openclaw:local .

# 2. 创建 .env 配置文件
cat > .env << 'EOF'
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_CONFIG_DIR=/path/to/.openclaw
OPENCLAW_WORKSPACE_DIR=/path/to/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=lan

# Gateway 认证 token（必须设置，否则无法访问 Web UI）
OPENCLAW_GATEWAY_TOKEN=your-random-token-here

# 自定义 Anthropic 端点（可选）
ANTHROPIC_BASE_URL=http://your-custom-endpoint:8045
ANTHROPIC_API_KEY=your-api-key
EOF

# 3. 启动服务
docker-compose up -d openclaw-gateway

# 4. 查看日志
docker-compose logs -f openclaw-gateway
```

### 访问 Web UI

必须带 token 访问：`http://localhost:18789/?token=your-random-token-here`

### 生成随机 Token

```bash
openssl rand -hex 16
```

### 迁移到其他机器

```bash
# 导出镜像
docker save openclaw:local | gzip > openclaw-local.tar.gz

# 复制到目标机器
scp openclaw-local.tar.gz .env docker-compose.yml target-host:~/openclaw/

# 在目标机器上加载并启动
ssh target-host
docker load < ~/openclaw/openclaw-local.tar.gz
cd ~/openclaw
docker-compose up -d openclaw-gateway
```

### 关键文件

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 镜像构建配置 |
| `docker-compose.yml` | 服务编排配置 |
| `.env` | 环境变量配置（不要提交到 Git） |
| `~/.openclaw/` | 用户配置目录（需要挂载到容器） |

### 注意事项

- `OPENCLAW_GATEWAY_TOKEN` 必须设置，否则 Web UI 无法访问
- `OPENCLAW_CONFIG_DIR` 需要指向宿主机的 `~/.openclaw` 目录
- Docker 容器内 Telegram 需要网络访问，确保容器可以访问外网
- Docker 容器内使用代理时，不能用 `127.0.0.1`，需用 `host.docker.internal` 或外部代理地址
- `.env` 文件包含敏感信息，已在 `.gitignore` 中排除

## macOS App 部署

### 构建和启动

```bash
# 构建项目
pnpm build

# 打包 macOS App
pnpm mac:package

# 启动 App
open dist/OpenClaw.app

# 或移动到 Applications
mv dist/OpenClaw.app /Applications/
open /Applications/OpenClaw.app
```

### 运行模式

| 模式 | 说明 | 使用场景 |
|------|------|----------|
| **Local** | 连接本地 Gateway，自动启用 launchd 服务 | 单机使用 |
| **Remote over SSH** | 通过 SSH 隧道连接远程主机 | 远程 Mac Mini |
| **Remote Direct** | 直接连接网关 URL (ws/wss) | 配合 Tailscale |

### LaunchAgent 管理

```bash
# App 使用的服务名
launchctl kickstart -k gui/$UID/bot.molt.gateway  # 重启
launchctl bootout gui/$UID/bot.molt.gateway       # 停止

# CLI 方式
openclaw gateway install   # 安装服务
openclaw gateway stop      # 停止服务
```

### 开机自启

1. 系统设置 → 通用 → 登录项
2. 添加 `/Applications/OpenClaw.app`

## Mac Mini 远程部署

参考文档：https://docs.openclaw.ai/platforms/mac/remote

### 远程主机配置

```bash
# 1. 克隆并构建
git clone https://github.com/y1y2u3u4/openclaw.git
cd openclaw && pnpm install && pnpm build

# 2. 全局链接 CLI
pnpm link --global

# 3. 确保 PATH 包含 openclaw（非交互式 shell）
echo "/Users/$(whoami)/Library/pnpm" | sudo tee -a /etc/paths
# 或创建符号链接
sudo ln -s $(which openclaw) /usr/local/bin/openclaw

# 4. 开启 SSH
sudo systemsetup -setremotelogin on

# 5. 配置环境变量
cat >> ~/.zshrc << 'EOF'
export ANTHROPIC_BASE_URL="http://your-custom-endpoint:8045"
export ANTHROPIC_API_KEY="your-api-key"
EOF

# 6. 启动 Gateway
openclaw gateway run --bind loopback --port 18789
```

### 本地连接远程

在 OpenClaw macOS App 的 **Settings → General** 中配置：

| 设置项 | 值 |
|--------|-----|
| OpenClaw runs | `Remote over SSH` |
| Transport | `SSH tunnel`（推荐） |
| SSH target | `user@mac-mini-ip` 或 Tailscale IP `user@100.x.x.x` |

### Tailscale 集成（推荐）

```bash
# 在远程主机上暴露网关
tailscale serve https / http://localhost:18789
```

然后使用 Direct 模式连接：`wss://mac-mini.tail-xxx.ts.net`

### Docker vs macOS App

| 方案 | 优点 | 缺点 |
|------|------|------|
| **macOS App** | 原生性能，菜单栏集成，权限管理 | 需要 GUI 环境 |
| **Docker** | 隔离性好，易迁移 | 无 macOS 专属功能，网络复杂 |

**推荐**：有显示器/VNC 时用 macOS App；纯 headless 用 Docker。

## Security & Configuration Tips

- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.

## Troubleshooting

- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).

## Lessons Learned

### [2026-02-03] Docker Gateway Token Mismatch 错误
- **问题**: 访问 `http://localhost:18789/chat` 报 "gateway token mismatch" 错误
- **原因**: Gateway token 有两个来源：1) 配置文件 `~/.openclaw/openclaw.json` 的 `gateway.auth.token`；2) 环境变量 `OPENCLAW_GATEWAY_TOKEN`。两者必须一致，且访问 URL 必须带 token 参数
- **解决**:
  1. 从配置文件读取现有 token：`cat ~/.openclaw/openclaw.json | grep -o '"token": "[^"]*"' | head -1`
  2. 更新 `.env` 使用相同的 token
  3. 访问时必须带 token：`http://localhost:18789/?token=YOUR_TOKEN`

### [2026-02-03] Docker 容器内 Telegram 连接失败
- **问题**: Docker 容器启动后 Telegram 报 "fetch failed" 错误
- **原因**: 配置文件中设置了代理 `http://127.0.0.1:1082`，但容器内 `127.0.0.1` 指向容器自身，无法访问宿主机代理
- **解决**: 使用 `host.docker.internal:1082` 替代 `127.0.0.1:1082`，或移除代理设置

### [2026-02-03] ANTHROPIC_BASE_URL 不生效
- **问题**: 设置 `ANTHROPIC_BASE_URL` 环境变量后，请求仍发送到官方端点
- **原因**: pi-ai 库返回的 Anthropic 模型已有默认 `baseUrl: "https://api.anthropic.com"`，原逻辑 `!model.baseUrl` 条件为 false
- **解决**: 修改 `src/agents/model-compat.ts`，当 `baseUrl` 为默认值时也允许环境变量覆盖

### [2026-02-03] Fork 同步上游更新
- **问题**: 如何保持 fork 与上游仓库同步，同时保留自定义修改
- **解决**:
  ```bash
  git remote add upstream https://github.com/openclaw/openclaw.git
  git fetch upstream && git rebase upstream/main
  git push origin main --force-with-lease
  ```

## Agent-Specific Notes

- Vocabulary: "makeup" = "mac app".
- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval; do not do this by default.
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don’t hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.
- Gateway currently runs only as the menubar app; there is no separate LaunchAgent/helper label installed. Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep openclaw` rather than assuming a fixed label. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**
- macOS logs: use `./scripts/clawlog.sh` to query unified logs for the OpenClaw subsystem; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don’t introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.
- Connection providers: when adding a new connection, update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.
- Version locations: `package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).
- **Restart apps:** “restart iOS/Android apps” means rebuild (recompile/install) and relaunch, not just kill/launch.
- **Device checks:** before testing, verify connected real devices (iOS/Android) before reaching for simulators/emulators.
- iOS Team ID lookup: `security find-identity -p codesigning -v` → use Apple Development (…) TEAMID. Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.
- A2UI bundle hash: `src/canvas-host/a2ui/.bundle.hash` is auto-generated; ignore unexpected changes, and only regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`) when needed. Commit the hash as a separate commit.
- Release signing/notary keys are managed outside the repo; follow internal release docs.
- Notary auth env vars (`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_API_KEY_P8`) are expected in your environment (per internal release docs).
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
- Lint/format churn:
  - If staged+unstaged diffs are formatting-only, auto-resolve without asking.
  - If commit/push already requested, auto-stage and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if needed), no extra confirmation.
  - Only ask when changes are semantic (logic/data/behavior).
- Lobster seam: use the shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors); apply palette to onboarding/config prompts and other TTY UI output as needed.
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief “other files present” note only if relevant.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a “session” file, open the Pi session logs under `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- Voice wake forwarding tips:
  - Command template should stay `openclaw-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don’t add extra quotes.
  - launchd PATH is minimal; ensure the app’s launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`openclaw` binaries resolve when invoked via `openclaw-mac`.
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool’s escaping.
- Release guardrails: do not change version numbers without operator’s explicit consent; always ask permission before running any npm publish/release step.

## NPM + 1Password (publish/verify)

- Use the 1password skill; all `op` commands must run inside a fresh tmux session.
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publish.
