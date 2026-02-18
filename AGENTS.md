# 仓库指南

- 仓库地址：https://github.com/openclaw/openclaw
- GitHub issues/comments/PR 评论：使用字面多行字符串或 `-F - <<'EOF'`（或 `$'...'`）来换行；不要嵌入 "\\n"。

## 项目结构与模块组织

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
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels (use existing channel/extension label colors).

## 文档链接（Mintlify）

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- When working with documentation, read the mintlify skill.
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

## 文档国际化（zh-CN）

- `docs/zh-CN/**` 是生成的；除非用户明确要求，否则不要编辑。
- 流程：更新英文文档 → 调整词汇表（`docs/.i18n/glossary.zh-CN.json`）→ 运行 `scripts/docs-i18n` → 仅在收到指示时进行定向修复。
- 翻译记忆：`docs/.i18n/zh-CN.tm.jsonl`（生成的）。
- 参见 `docs/.i18n/README.md`。
- 该流程可能较慢/低效；如果拖延太久，在 Discord 上联系 @jospalmbier，而不是自己想办法绕过。

## exe.dev 虚拟机操作（通用）

- 访问：稳定路径是 `ssh exe.dev` 然后 `ssh vm-name`（假设 SSH 密钥已配置）。
- SSH 不稳定：使用 exe.dev Web 终端或 Shelley（Web 代理）；为长时间操作保持 tmux 会话。
- 更新：`sudo npm i -g openclaw@latest`（全局安装需要 `/usr/lib/node_modules` 的 root 权限）。
- 配置：使用 `openclaw config set ...`；确保设置了 `gateway.mode=local`。
- Discord：仅存储原始 token（不要加 `DISCORD_BOT_TOKEN=` 前缀）。
- 重启：停止旧网关并运行：
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- 验证：`openclaw channels status --probe`、`ss -ltnp | rg 18789`、`tail -n 120 /tmp/openclaw-gateway.log`。

## 构建、测试和开发命令

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- If deps are missing (for example `node_modules` missing, `vitest not found`, or `command not found`), run the repo’s package-manager install command (prefer lockfile/README-defined PM), then rerun the exact requested command once. Apply this to test/build/lint/typecheck/dev commands; if retry still fails, report the command and first actionable error.
- Pre-commit hooks: `prek install` (runs same checks as CI)
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch. Release checklist: `docs/platforms/mac/release.md`.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Format check: `pnpm format` (oxfmt --check)
- Format fix: `pnpm format:fix` (oxfmt --write)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## 代码风格与命名规范

- 语言：TypeScript（ESM）。优先使用严格类型；避免 `any`。
- 格式化/代码检查通过 Oxlint 和 Oxfmt；提交前运行 `pnpm check`。
- 禁止添加 `@ts-nocheck`，禁止禁用 `no-explicit-any`；应修复根本原因，仅在必要时更新 Oxlint/Oxfmt 配置。
- 禁止通过原型变异共享类行为（`applyPrototypeMixins`、在 `.prototype` 上使用 `Object.defineProperty`、或导出 `Class.prototype` 进行合并）。使用显式继承/组合（`A extends B extends C`）或辅助函数组合，以便 TypeScript 能进行类型检查。
- 如需使用此模式，须在发布前获得明确批准；默认做法是拆分/重构为显式类继承结构并保持成员强类型。
- 在测试中，优先使用实例级 stub 而非原型变异（`SomeClass.prototype.method = ...`），除非测试明确说明了为什么需要原型级 patch。
- 为复杂或不易理解的逻辑添加简要代码注释。
- 保持文件简洁；提取辅助函数而不是创建"V2"副本。使用现有模式处理 CLI 选项和通过 `createDefaultDeps` 进行依赖注入。
- 目标将文件保持在约 700 行以内；仅为指导方针（非硬性规则）。当有助于提高清晰度或可测试性时进行拆分/重构。
- 命名：产品/应用/文档标题使用 **OpenClaw**；CLI 命令、包/二进制文件、路径和配置键使用 `openclaw`。

## 发布渠道（命名）

- stable：仅限标签发布（例如 `vYYYY.M.D`），npm dist-tag `latest`。
- beta：预发布标签 `vYYYY.M.D-beta.N`，npm dist-tag `beta`（可能不包含 macOS 应用）。
- dev：`main` 分支的最新提交（无标签；git checkout main）。

## 测试指南

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what’s covered: `docs/testing.md`.
- Changelog: user-facing changes only; no internal/meta notes (version alignment, appcast reminders, release process).
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

## Commit & Pull Request Guidelines

**Full maintainer PR workflow (optional):** If you want the repo's end-to-end maintainer workflow (triage order, quality bar, rebase rules, commit/changelog conventions, co-contributor policy, and the `review-pr` > `prepare-pr` > `merge-pr` pipeline), see `.agents/skills/PR_WORKFLOW.md`. Maintainers may use other workflows; when a maintainer specifies a workflow, follow that. If no workflow is specified, default to PR_WORKFLOW.

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PR submission template (canonical): `.github/pull_request_template.md`
- Issue submission templates (canonical): `.github/ISSUE_TEMPLATE/`

## 简写命令

- `sync`：如果工作树有未提交更改，提交所有更改（选择合理的 Conventional Commit 消息），然后 `git pull --rebase`；如果 rebase 冲突且无法解决，停止；否则 `git push`。

### PR Workflow (Review vs Land)

- If `git branch -d/-D <branch>` is policy-blocked, delete the local ref directly: `git update-ref -d refs/heads/<branch>`.
- Bulk PR close/reopen safety: if a close action would affect more than 5 PRs, first ask for explicit user confirmation with the exact PR count and target scope/query.

## 安全与配置提示

- Web 提供者将凭证存储在 `~/.openclaw/credentials/`；如果登出，重新运行 `openclaw login`。
- Pi 会话默认位于 `~/.openclaw/sessions/`；基础目录不可配置。
- 环境变量：参见 `~/.profile`。
- 永远不要提交或发布真实电话号码、视频或实际配置值。在文档、测试和示例中使用明显的假占位符。
- 发布流程：在进行任何发布工作前，始终阅读 `docs/reference/RELEASING.md` 和 `docs/platforms/mac/release.md`；这些文档已回答的例行问题不要再问。

## GHSA（仓库安全公告）补丁/发布

- 获取：`gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`
- 最新 npm 版本：`npm view openclaw version --userconfig "$(mktemp)"`
- 私有 fork 的 PR 必须已关闭：
  `fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)`
  `gh pr list -R "$fork" --state open`（必须为空）
- 描述中的换行陷阱：通过 heredoc 写 Markdown 到 `/tmp/ghsa.desc.md`（不要嵌入 `"\\n"` 字符串）
- 通过 jq 构建补丁 JSON：`jq -n --rawfile desc /tmp/ghsa.desc.md '{summary,severity,description:$desc,vulnerabilities:[...]}' > /tmp/ghsa.patch.json`
- 补丁 + 发布：`gh api -X PATCH /repos/openclaw/openclaw/security-advisories/<GHSA> --input /tmp/ghsa.patch.json`（发布 = 包含 `"state":"published"`；无 `/publish` 端点）
- 发布失败（HTTP 422）：缺少 `severity`/`description`/`vulnerabilities[]`，或私有 fork 仍有未关闭的 PR
- 验证：重新获取；确保 `state=published`、`published_at` 已设置；`jq -r .description | rg '\\\\n'` 无输出

## 故障排查

- 品牌重塑/迁移问题或遗留配置/服务警告：运行 `openclaw doctor`（参见 `docs/gateway/doctor.md`）。

## Agent 专属注意事项

- Vocabulary: "makeup" = "mac app".
- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.
- When adding a new `AGENTS.md` anywhere in the repo, also add a `CLAUDE.md` symlink pointing to it (example: `ln -s AGENTS.md CLAUDE.md`).
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
- "Bump version everywhere" means all version locations above **except** `appcast.xml` (only touch appcast when cutting a new macOS Sparkle release).
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

## NPM + 1Password（发布/验证）

- 使用 1password 技能；所有 `op` 命令必须在新的 tmux 会话中运行。
- 登录：`eval "$(op signin --account my.1password.com)"`（应用已解锁 + 集成已开启）。
- OTP：`op read 'op://Private/Npmjs/one-time password?attribute=otp'`。
- 发布：`npm publish --access public --otp="<otp>"`（从包目录运行）。
- 验证（无本地 npmrc 副作用）：`npm view <pkg> version --userconfig "$(mktemp)"`。
- 发布后终止 tmux 会话。

## 插件快速发布（不发布核心 `openclaw`）

- 仅发布已在 npm 上的插件。源列表见 `docs/reference/RELEASING.md` 中的"Current npm plugin list"。
- 所有 CLI `op` 调用和 `npm publish` 必须在 tmux 中运行，以避免挂起/中断：
  - `tmux new -d -s release-plugins-$(date +%Y%m%d-%H%M%S)`
  - `eval "$(op signin --account my.1password.com)"`
- 1Password 辅助命令：
  - `npm login` 使用的密码：
    `op item get Npmjs --format=json | jq -r '.fields[] | select(.id=="password").value'`
  - OTP：
    `op read 'op://Private/Npmjs/one-time password?attribute=otp'`
- 快速发布循环（本地辅助脚本放 `/tmp` 即可；保持仓库干净）：
  - 比较本地插件 `version` 与 `npm view <name> version`
  - 仅在版本不同时执行 `npm publish --access public --otp="<otp>"`
  - 如果包在 npm 上不存在或版本已匹配则跳过。
- 保持 `openclaw` 不变：除非明确要求，否则不要从仓库根目录运行 publish。
- 每次发布后的检查：
  - 每个插件：`npm view @openclaw/<name> version --userconfig "$(mktemp)"` 应为 `2026.2.17`
  - 核心守护：`npm view openclaw version --userconfig "$(mktemp)"` 应保持为之前的版本，除非明确要求更新。

## 变更日志发布说明

- 发布 mac beta GitHub 预发布版时：
  - 从发布提交打标签 `vYYYY.M.D-beta.N`（例如：`v2026.2.15-beta.1`）。
  - 创建预发布版，标题为 `openclaw YYYY.M.D-beta.N`。
  - 使用 `CHANGELOG.md` 版本段落中的发布说明（`Changes` + `Fixes`，不重复标题）。
  - 至少附上 `OpenClaw-YYYY.M.D.zip` 和 `OpenClaw-YYYY.M.D.dSYM.zip`；如有 `.dmg` 也一并附上。

- 保持 `CHANGELOG.md` 顶部版本条目按影响度排序：
  - `### Changes` 在前。
  - `### Fixes` 去重并排序，用户可见的修复优先。
- 打标签/发布前，运行：
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `pnpm test:install:smoke` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（非 root 冒烟测试路径）。
