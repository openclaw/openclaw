# AGENTS.MD

Telegraph 风格。仅根级规则。在子目录工作前先阅读作用域内的 `AGENTS.md`。

## Start（开始）

- Repo：`https://github.com/openclaw/openclaw`
- 回复：仅使用 repo-root 引用：`extensions/telegram/src/index.ts:80`。不使用绝对路径，不使用 `~/`。
- 先运行 docs list：如有 `pnpm docs:list`；仅阅读相关文档。
- 高置信度答案：仅在修复/分类时使用，验证源代码、测试、已发布/当前行为和依赖契约后再做决定。
- 依赖支持的行为：先阅读上游依赖的文档/源代码/类型。不假设 API、默认值、错误、时间或运行时行为。
- 尽可能现场验证。在假设实时测试被阻止前检查 env/`~/.profile` 中的密钥；保持秘密输出编辑。
- 缺少依赖：`pnpm install`，重试一次，然后报告第一个可操作错误。
- CODEOWNERS：维护/重构/测试可以。其他更大的行为/产品/安全/所有权：需要所有者询问/审查。
- 措辞：产品/文档/UI/changelog 使用 "plugin/plugins"；`extensions/` 是内部的。
- 新渠道/plugin/应用/文档界面：更新 `.github/labeler.yml` + GH 标签。
- 新的 `AGENTS.md`：添加同级 `CLAUDE.md` 符号链接。

## Map（地图）

- Core TS（核心 TypeScript）：`src/`、`ui/`、`packages/`；plugins（插件）：`extensions/`；SDK：`src/plugin-sdk/*`；channels（渠道）：`src/channels/*`；loader（加载器）：`src/plugins/*`；protocol（协议）：`src/gateway/protocol/*`；docs/apps（文档/应用）：`docs/`、`apps/`、`Swabble/`。
- Installers（安装程序）：同级 `../openclaw.ai`。
- 作用域指南存在于：`extensions/`、`src/{plugin-sdk,channels,plugins,gateway,gateway/protocol,agents}/`、`test/helpers*/`、`docs/`、`ui/`、`scripts/`。

## Architecture（架构）

- Core（核心）保持对扩展无感知。当 manifest/registry/capability 契约可用时，Core 中不应有捆绑的 id。
- 扩展仅通过 `openclaw/plugin-sdk/*`、manifest 元数据、注入的运行时辅助函数和文档化的 barrel（`api.ts`、`runtime-api.ts`）进入 core。
- 扩展 prod 代码：不使用 core `src/**`、`src/plugin-sdk-internal/**`、其他扩展 `src/**` 或包外的相对路径。
- Core/测试：不使用深层 plugin 内部结构（`extensions/*/src/**`、`onboard.js`）。使用 `api.ts`、SDK facade、通用契约。
- 扩展拥有的行为保持在扩展中：修复、检测、引导、认证/提供商默认值、提供商工具/设置。
- Owner 边界：在 owner 模块中修复特定 owner 的行为。Shared/core 仅获得通用 seam；当多个 owner 需要时，才添加通用 core seam。如果 bug 涉及扩展或其依赖，从该扩展开始，仅当多个 owner 需要时才添加通用 core seam。
- 旧配置修复：doctor/fix 路径，而非启动/加载时的 core 迁移。
- 断言扩展特定行为的 Core 测试：移至 owner 扩展或通用契约测试。
- 新 seam：向后兼容、有文档化、有版本控制。第三方插件存在。
- Channels（渠道）：`src/channels/**` 是实现；plugin 作者使用 SDK seam。
- Providers（提供商）：core 拥有通用循环；provider plugins 拥有 auth/catalog/运行时钩子。
- Gateway 协议变更：首先是追加式的；不兼容的变更需要版本控制/文档/客户端跟进。
- Config 契约：导出的类型、schema/help、元数据、基线、文档对齐。退休的公钥保持退休；兼容性问题在原始迁移/doctor 中处理。
- 方向：manifest 优先的控制平面；有针对性的运行时加载器；无隐藏的契约绕过；广泛的可变注册表是过渡性的。
- Prompt cache（提示缓存）：在模型/工具 payload 之前，对 maps/sets/registries/plugin lists/files/network results 进行确定性排序。尽可能保留旧的 transcript 字节。

## Commands（命令）

- Runtime（运行时）：Node 22+。保持 Node + Bun 路径正常工作。
- Install（安装）：`pnpm install`（如触碰则保持 Bun lock/patches 对齐）。
- CLI：`pnpm openclaw ...` 或 `pnpm dev`；build（构建）：`pnpm build`。
- Smart gate（智能门控）：`pnpm check:changed`；解释 `pnpm changed:lanes --json`；staged preview（暂存预览）`pnpm check:changed --staged`。
- Sparse worktrees（稀疏工作树）：`pnpm check:changed` 是稀疏安全的，可能会跳过稀疏缺失的 typecheck 项目；不要仅仅为了满足 changed-gate tsgo 而扩展稀疏检出。直接 `pnpm tsgo*` 仍然严格；当需要直接 typecheck 证明时使用更完整的工作树。
- Prod sweep（生产全面检查）：`pnpm check`；tests（测试）：`pnpm test`、`pnpm test:changed`、`pnpm test:serial`、`pnpm test:coverage`。
- Extension tests（扩展测试）：`pnpm test:extensions`、`pnpm test extensions`、`pnpm test extensions/<id>`。
- 针对性测试：`pnpm test <path-or-filter> [vitest args...]`；不要直接使用 `vitest`。
- 仅使用 Vitest flags；不要使用 Jest flags 如 `--runInBand`。对于串行运行使用 `pnpm test:serial` 或 `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test ...`。
- Typecheck（类型检查）：仅 `tsgo` lanes（`pnpm tsgo*`、`pnpm check:test-types`）；不要添加 `tsc --noEmit`、`typecheck`、`check:types`。
- Formatting（格式化）：使用 `oxfmt`，而非 Prettier。优先使用 `pnpm format:check` / `pnpm format`；对于针对性文件使用 `pnpm exec oxfmt --check --threads=1 <files...>` 或 `pnpm exec oxfmt --write --threads=1 <files...>`。
- Linting：使用 repo wrappers（`pnpm lint:*`、`scripts/run-oxlint.mjs`）；除非 repo 脚本使用它们，否则不要调用通用 JS formatter/lints。
- Heavy checks（重检查）：`OPENCLAW_LOCAL_CHECK=1`，模式 `OPENCLAW_LOCAL_CHECK_MODE=throttled|full`；CI/共享使用 `OPENCLAW_LOCAL_CHECK=0`。
- Blacksmith/Testbox：在有 Blacksmith 访问权限的维护者机器上，广泛的/共享的验证默认为 Testbox。包括 `pnpm check`、`pnpm check:changed`、`pnpm test`、`pnpm test:changed`、Docker/E2E/live/package/build gates 以及任何可能对许多 Vitest 项目进行扇出的命令。除非用户明确要求本地证明或设置 `OPENCLAW_LOCAL_CHECK_MODE=throttled|full`，否则不要在本地启动这些广泛的 gates。
- Local validation（本地验证）：仅针对性的编辑循环，如 `pnpm test <specific-file>`、针对性的格式化器检查和小型的 lint/type 探针。如果本地命令扩展到针对性证明之外，停止它并将广泛的 gate 移到 Testbox。
- Testbox 使用：从 repo root 运行，使用 `blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90` 提前预热，重复使用返回的 `tbx_...` id 进行所有 `run`/`download` 命令，并在交接前停止您创建的 box。Timeout bins（超时区间）：`90` 分钟默认，`240` 多小时，`720` 全天，`1440` 过夜；超过 `1440` 需要明确批准和清理。
- Testbox 全套配置：`blacksmith testbox run --id <ID> "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test"`。对于可安装包的证明，优先使用 GitHub `Package Acceptance` workflow，而非临时 Testbox 命令。

## GitHub / CI

- Triage（分类）：先列出，少量补充。使用有界的 `gh --json --jq`；避免重复的全评论扫描。
- 自动 PR/issue 发现：跳过维护者拥有的项目，除非直接相关。未经 Peter 要求，不评论、关闭、标签、重命名、变基、整理或合并。
- PR scan/triage（PR 扫描/分类）：不主动 PR 评论/审查。仅在明确要求时或在需要原因评论的关闭/重复操作时在聊天中报告。
- Search/dedupe（搜索/去重）：优先使用 `gh search issues 'repo:openclaw/openclaw is:open <terms>' --json number,title,state,updatedAt --limit 20`。
- GitHub 搜索布尔文本很挑剔。如果 `OR` 查询返回空，将确切术语拆分并分别搜索 title/body/comments，然后再得出无结果的结论。
- PR shortlist（PR 简报）：`gh pr list ...`；然后 `gh pr view <n> --json number,title,body,closingIssuesReferences,files,statusCheckRollup,reviewDecision`。
- PR 落地后：搜索重复的 open issues/PRs。关闭前：评论原因 + 规范链接。
- GH 评论中包含 markdown 反引号、`$` 或 shell 片段：避免内联双引号 `--body`；使用单引号或 `--body-file`。
- PR 执行 artifacts/截图：将它们附加到 PR、评论或外部 artifact store。不要将 `.github/pr-assets` 或其他仅 PR 的 assets 添加到 repo。
- PR review 回答必须明确涵盖：我们试图修复什么 bug/行为；PR/issue URL(s) 和受影响的端点/界面；这是否是最佳可能的修复，并附有来自代码、测试、CI 和已发布/当前行为的高置信度证据。
- CI polling（CI 轮询）：精确的 SHA，仅需字段。例如：`gh api repos/<owner>/<repo>/actions/runs/<id> --jq '{status,conclusion,head_sha,updated_at,name,path}'`。
- Post-land wait（落地后等待）：最小化。仅精确的落地 SHA。如果在 `main` 上被取代，同分支的 `cancel-in-progress` 取消是预期的；一旦本地触及表面证明存在就停止。除非被要求，否则不要等待更新的无关 `main`。
- Wait matrix（等待矩阵）：
  - 从不：`Auto response`、`Labeler`、`Docs Sync Publish Repo`、`Docs Agent`、`Test Performance Agent`、`Stale`。
  - 条件性：仅精确 SHA 的 `CI`；仅 docs 任务/无本地 docs 证明的 `Docs`；仅 workflow/composite/CI-policy 编辑的 `Workflow Sanity`；仅 plugin package/release 元数据的 `Plugin NPM Release`。
  - 仅 release/manual：`Docker Release`、`OpenClaw NPM Release`、`macOS Release`、`OpenClaw Release Checks`、`Cross-OS Release Checks`、`NPM Telegram Beta E2E`。
  - 仅 explicit/surface：`QA-Lab - All Lanes`、`Scheduled Live And E2E`、`Install Smoke`、`CodeQL`、`Sandbox Common Smoke`、`Parity gate`、`Blacksmith Testbox`、`Control UI Locale Refresh`。
- `/landpr`：不在 `auto-response` 或 `check-docs` 上空闲。当 `check-docs` 已失败并有可操作的相关错误时，将 docs 视为本地证明。
- 每 30-60s 轮询。仅在失败/完成或明确需要时获取 jobs/logs/artifacts。

## Gates（门控）

- Pre-commit hook（预提交钩子）：仅 staged formatting（暂存格式化）。验证是明确的。
- Changed lanes（变更通道）：
  - core prod：core prod typecheck + core tests
  - core tests：core test typecheck/tests
  - extension prod：extension prod typecheck + extension tests
  - extension tests：extension test typecheck/tests
  - public SDK/plugin contract：extension prod/test too
  - unknown root/config：all lanes
- 在代码/测试/运行时/配置更改进行交接/push 前：在维护者机器上默认在 Testbox 中运行 `pnpm check:changed`。仅测试：在 Testbox 中默认运行 `pnpm test:changed`。完整生产扫描：在 Testbox 中运行 `pnpm check`。仅在针对性证明或明确要求时才使用本地。
- 如果 `pnpm test:changed` 或 `pnpm check:changed` 选择广泛的/共享的 lanes，它属于 Testbox；当它扇出后，不要让它在本地继续。
- 默认情况下，docs/changelog-only 和 CI/workflow metadata-only 更改不是 changed-gate 工作。使用 `git diff --check` 加上相关的 formatter/docs/workflow sanity check；仅当脚本、测试配置、生成的 docs/API、包元数据或运行时/构建行为更改时才升级到 `pnpm check:changed`。
- Rebase sanity（变基理智检查）：在绿色 `pnpm check:changed` 后，在当前 `origin/main` 上进行干净的重基不需要重新运行完整的 changed gate，当 rebase 没有冲突且分支 diff 实质上未更改时。进行快速的 `git status`、`git diff --check` 和 diff/stat 理智检查；仅当冲突解决、上游重叠、生成漂移、依赖/配置更改或触及文件内容更改使先前结果过时时才重新运行针对性或完整检查。
- Landing on `main`（合并到 main）：验证落地附近触及的表面。默认可行标准：`pnpm check` + `pnpm test`。
- Hard build gate（硬构建门控）：如果构建输出、包装、lazy/module boundaries 或已发布 surface 可能更改，则 push 前运行 `pnpm build`。
- 不要合并相关的失败 format/lint/type/build/tests。如果与最新 `origin/main` 无关，说明有针对性的证明。
- Generated/API drift（生成/API 漂移）：`pnpm check:architecture`、`pnpm config:docs:gen/check`、`pnpm plugin-sdk:api:gen/check`。跟踪 `docs/.generated/*.sha256`；忽略完整 JSON。

## Code（代码）

- TS ESM，strict（严格）。避免 `any`；优先使用真实类型、`unknown`、窄适配器。
- 不使用 `@ts-nocheck`。Lint 抑制仅在有意且有解释时使用。
- 外部边界：优先使用 `zod` 或现有 schema 辅助函数。
- 运行时分支：优先使用 discriminated unions/closed codes（可辨识联合/闭合代码）而非自由格式字符串。
- 避免语义哨兵：`?? 0`、空对象/字符串等。
- Dynamic import（动态导入）：同一 prod 模块不要同时使用 static + dynamic import。使用 `*.runtime.ts` lazy boundary。编辑后运行 `pnpm build`；检查 `[INEFFECTIVE_DYNAMIC_IMPORT]`。
- Cycles（循环）：保持 `pnpm check:import-cycles` + architecture/madge 绿色。
- Classes（类）：不要使用 prototype mixins/mutations。优先使用继承/组合。测试优先使用 per-instance stubs。
- Comments（注释）：简短，仅针对非显而易见的逻辑。
- 当清晰度/可测试性提高时，约 ~700 LOC 时拆分文件。
- Naming（命名）：**OpenClaw** 产品/文档；`openclaw` CLI/package/path/config。
- English（英语）：美式拼写。

## Tests（测试）

- Vitest。 colocated（并置）`*.test.ts`；e2e `*.e2e.test.ts`；示例模型 `sonnet-4.6`、`gpt-5.4`。
- 避免脆弱的测试，这些测试 grep workflow/docs 字符串以获取 operator policy。优先使用可执行行为、解析的 config/schema 检查或 live run proof；将 release/CI 策略提醒放在 AGENTS/docs 中。
- 清理 timers/env/globals/mocks/sockets/temp dirs/module state；`--isolate=false` 安全。
- Hot tests（热测试）：避免 per-test `vi.resetModules()` + 重导入。使用 `pnpm test:perf:imports <file>` / `pnpm test:perf:hotspots --limit N` 测量。
- Seam depth（接缝深度）：纯 helper/contract 单元测试；每个边界一个集成冒烟测试。
- 直接 Mock 昂贵的接缝：scanners、manifests、registries、fs crawls、provider SDKs、network/process launch。
- 优先使用注入；如果需要模块 mock，mock 窄的本地 `*.runtime.ts`，而非宽的 barrel 或 `openclaw/plugin-sdk/*`。
- 共享 fixtures/builders；删除重复断言；断言此处可能回归的行为。
- 未经明确批准，不要编辑 baseline/inventory/ignore/snapshot/expected-failure 文件来使检查沉默。
- 不要在同一 worktree 中并发运行多个独立的 `pnpm test`/Vitest 命令。它们可能在 `node_modules/.experimental-vitest-cache` 上竞争并因 `ENOTEMPTY` 失败。使用一个分组的 `pnpm test ...` 调用，按顺序运行针对性 lanes，或在需要真正并行 Vitest 进程时设置不同的 `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` 值。
- 测试 workers 最多 16。内存压力：`OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`。
- Live（实时）：`OPENCLAW_LIVE_TEST=1 pnpm test:live`；详细 `OPENCLAW_LIVE_TEST_QUIET=0`。
- Guide（指南）：`docs/help/testing.md`。

## Docs / Changelog（文档/更新日志）

- Docs 随 behavior/API 变更。使用 docs list/read_when hints；按 `docs/AGENTS.md` 中的 docs 链接。
- Changelog 仅面向用户；纯测试/内部通常不添加条目。
- Changelog 放置位置：活动版本 `### Changes`/`### Fixes`；每个添加的条目必须包含至少一个 `Thanks @author` 归属，使用 credited GitHub 用户名。不要添加 `Thanks @codex`、`Thanks @openclaw` 或 `Thanks @steipete`。
- Changelog 条目始终为单行。不跨多行包装/延续。长条目保持在一行上，以便去重、PR-ref 和 credit-audit 工具正常工作，视觉风格保持一致。

## Git

- 通过 `scripts/committer "<msg>" <file...>` 提交；仅暂存预期文件。它格式化暂存文件；仍然运行 gates。
- Commits（提交）：conventional-ish，简洁，分组。
- 除非明确，否则不手动 stash/autostash。未经请求，不进行分支/worktree 更改。
- `main`：无 merge commits；在 push 前 rebase 到最新的 `origin/main`。在一次绿色运行加上干净的 rebase 理智通过后，不要用重复的完整 gates 追逐 `main`。
- 用户说 `commit`：仅您的更改。用户说 `commit all`：所有更改分组。用户说 `push`：可能先 `git pull --rebase`。
- 不要删除/重命名意外的文件；如果阻塞则询问，否则忽略。
- 批量 PR close/reopen >5：询问数量/范围。
- PR/issue workflows（工作流）：`$openclaw-pr-maintainer`。`/landpr`：`~/.codex/prompts/landpr.md`。

## Security / Release（安全/发布）

- 绝不提交真实电话号码、视频、凭据、实时配置。
- Secrets（密钥）：渠道/提供商凭据在 `~/.openclaw/credentials/`；模型 auth profiles 在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`。
- Env keys（环境密钥）：检查 `~/.profile`。
- 依赖 patches/overrides/vendor 更改需要明确批准。`pnpm.patchedDependencies` 仅精确版本。
- Carbon pins owner-only：不要更改 `@buape/carbon`，除非 Shadow（`@thewilloftheshadow`，经 `gh` 验证）要求。
- Releases/publish/version bumps 需要明确批准。发布文档：`docs/reference/RELEASING.md`；使用 `$openclaw-release-maintainer`。
- GHSA/advisories（安全公告）：`$openclaw-ghsa-maintainer`。
- Beta tag/version 匹配：`vYYYY.M.D-beta.N` -> npm `YYYY.M.D-beta.N --tag beta`。

## Apps / Platform（应用/平台）

- 在模拟器/仿真器测试前，检查真实 iOS/Android 设备。
- "restart iOS/Android apps"（重启 iOS/Android 应用）= 重建/重新安装/重新启动，而非 kill/launch。
- SwiftUI：使用 Observation（`@Observable`、`@Bindable`）而非新的 `ObservableObject`。
- Mac gateway（Mac 网关）：使用 app 或 `openclaw gateway restart/status --deep`；不要使用临时 tmux gateway。日志：`./scripts/clawlog.sh`。
- Version bump touches（版本碰撞涉及）：`package.json`、`apps/android/app/build.gradle.kts`、`apps/ios/version.json` + `pnpm ios:version:sync`、macOS `Info.plist`、`docs/install/updating.md`。Appcast 仅用于 Sparkle 发布。
- Mobile LAN pairing（移动端局域网配对）：纯文本 `ws://` 仅 loopback。私有网络 `ws://` 需要 `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`；Tailscale/公共使用 `wss://` 或隧道。
- A2UI hash `src/canvas-host/a2ui/.bundle.hash`：生成的；除非运行 `pnpm canvas:a2ui:bundle` 否则忽略；单独提交。

## Ops / Footguns（运维/易犯错误）

- 远程安装文档：`docs/install/{exe-dev,fly,hetzner}.md`。Parallels smoke：`$openclaw-parallels-smoke`；Discord roundtrip：`parallels-discord-roundtrip`。
- Rebrand/migration/config 警告：运行 `openclaw doctor`。
- 绝不编辑 `node_modules`。
- Local-only `.agents` ignores（仅本地 .agents 忽略）：`.git/info/exclude`，而非 repo `.gitignore`。
- CLI progress（CLI 进度）：`src/cli/progress.ts`；status tables（状态表）：`src/terminal/table.ts`。
- 连接/提供商添加：更新所有 UI surfaces + docs + status/config 表单。
- Provider tool schemas（提供商工具 schema）：优先使用 flat string enum helpers，而非 `Type.Union([Type.Literal(...)])`；一些提供商拒绝 `anyOf`。不是 repo 范围的 protocol/schema 禁令。
- External messaging（外部消息）：无 token-delta 渠道消息。遵循 `docs/concepts/streaming.md`；preview/block streaming 使用 edits/chunks 并保留 final/fallback 投递。
