# 仓库指南

- 仓库地址：https://github.com/openclaw/openclaw
- 在对话回复中，文件引用必须使用相对于仓库根目录的路径（示例：`extensions/bluebubbles/src/channel.ts:80`）；禁止使用绝对路径或 `~/...`。
- GitHub issues/评论/PR 评论：使用字面量多行字符串或 `-F - <<'EOF'`（或 `$'...'`）来实现真正的换行；禁止嵌入 `"\\n"`。
- GitHub 评论陷阱：当正文包含反引号或 shell 特殊字符时，绝对不要使用 `gh issue/pr comment -b "..."`。务必使用单引号 heredoc（`-F - <<'EOF'`），以避免命令替换/转义损坏。
- GitHub 链接陷阱：不要用反引号包裹 `#24643` 这样的 issue/PR 引用（否则不会自动链接）。使用纯文本 `#24643`（可选附加完整 URL）。
- 安全公告分析：在进行分级/严重性判断之前，请阅读 `SECURITY.md`，以符合 OpenClaw 的信任模型和设计边界。

## 项目结构与模块组织

- 源代码：`src/`（CLI 接线在 `src/cli`，命令在 `src/commands`，Web 提供者在 `src/provider-web.ts`，基础设施在 `src/infra`，媒体流水线在 `src/media`）。
- 测试：与源码并置的 `*.test.ts`。
- 文档：`docs/`（图片、队列、Pi 配置）。构建输出在 `dist/`。
- 插件/扩展：位于 `extensions/*`（工作区包）。插件专有依赖项放在扩展的 `package.json` 中；除非核心需要，不要添加到根 `package.json`。
- 插件：安装时在插件目录中运行 `npm install --omit=dev`；运行时依赖必须在 `dependencies` 中。避免在 `dependencies` 中使用 `workspace:*`（会导致 npm install 出错）；将 `openclaw` 放在 `devDependencies` 或 `peerDependencies` 中（运行时通过 jiti 别名解析 `openclaw/plugin-sdk`）。
- 从 `https://openclaw.ai/*` 提供的安装程序：位于兄弟仓库 `../openclaw.ai`（`public/install.sh`、`public/install-cli.sh`、`public/install.ps1`）。
- 消息频道：重构共享逻辑（路由、白名单、配对、命令门控、入门引导、文档）时，始终考虑**所有**内置和扩展频道。
  - 核心频道文档：`docs/channels/`
  - 核心频道代码：`src/telegram`、`src/discord`、`src/slack`、`src/signal`、`src/imessage`、`src/web`（WhatsApp web）、`src/channels`、`src/routing`
  - 扩展（频道插件）：`extensions/*`（例如 `extensions/msteams`、`extensions/matrix`、`extensions/zalo`、`extensions/zalouser`、`extensions/voice-call`）
- 添加频道/扩展/应用/文档时，更新 `.github/labeler.yml` 并创建匹配的 GitHub 标签（使用现有的频道/扩展标签颜色）。

## 文档链接（Mintlify）

- 文档托管在 Mintlify（docs.openclaw.ai）。
- `docs/**/*.md` 中的内部文档链接：使用相对于根目录的路径，不带 `.md`/`.mdx`（示例：`[配置](/configuration)`）。
- 处理文档时，请阅读 mintlify skill。
- 章节交叉引用：在根相对路径上使用锚点（示例：`[Hooks](/configuration#hooks)`）。
- 文档标题和锚点：避免在标题中使用破折号和撇号，因为它们会破坏 Mintlify 锚点链接。
- 当 Peter 索取链接时，回复完整的 `https://docs.openclaw.ai/...` URL（不使用根相对路径）。
- 修改文档时，在回复末尾附上引用的 `https://docs.openclaw.ai/...` URL。
- README（GitHub）：保持使用绝对文档 URL（`https://docs.openclaw.ai/...`），以确保链接在 GitHub 上正常工作。
- 文档内容必须通用：不使用个人设备名称/主机名/路径；使用 `user@gateway-host` 和"网关主机"等占位符。

## 文档国际化（zh-CN）

- `docs/zh-CN/**` 是自动生成的；除非用户明确要求，否则不要编辑。
- 流程：更新英文文档 → 调整词汇表（`docs/.i18n/glossary.zh-CN.json`）→ 运行 `scripts/docs-i18n` → 仅在有指示时进行针对性修复。
- 翻译记忆库：`docs/.i18n/zh-CN.tm.jsonl`（自动生成）。
- 参见 `docs/.i18n/README.md`。
- 流程可能较慢/效率低；如果拖延严重，在 Discord 上 ping @jospalmbier，而不是绕过问题。

## exe.dev 虚拟机操作（通用）

- 访问：稳定路径是 `ssh exe.dev` 然后 `ssh vm-name`（假设 SSH 密钥已配置）。
- SSH 不稳定：使用 exe.dev Web 终端或 Shelley（Web 代理）；长时间操作保持 tmux 会话。
- 更新：`sudo npm i -g openclaw@latest`（全局安装需要 `/usr/lib/node_modules` 的 root 权限）。
- 配置：使用 `openclaw config set ...`；确保设置了 `gateway.mode=local`。
- Discord：仅存储原始 token（不带 `DISCORD_BOT_TOKEN=` 前缀）。
- 重启：停止旧网关并运行：
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- 验证：`openclaw channels status --probe`、`ss -ltnp | rg 18789`、`tail -n 120 /tmp/openclaw-gateway.log`。

## 构建、测试和开发命令

- 运行时基准：Node **22+**（保持 Node + Bun 路径正常工作）。
- 安装依赖：`pnpm install`
- 如果依赖缺失（例如 `node_modules` 不存在、`vitest not found` 或 `command not found`），运行仓库的包管理器安装命令（优先使用 lockfile/README 中定义的 PM），然后重新运行一次请求的命令。适用于 test/build/lint/typecheck/dev 命令；若重试仍失败，报告命令和第一个可执行的错误。
- 预提交钩子：`prek install`（运行与 CI 相同的检查）
- 也支持：`bun install`（修改依赖/补丁时保持 `pnpm-lock.yaml` + Bun 补丁同步）。
- TypeScript 执行优先使用 Bun（脚本、开发、测试）：`bun <file.ts>` / `bunx <tool>`。
- 开发模式运行 CLI：`pnpm openclaw ...`（bun）或 `pnpm dev`。
- Node 仍支持运行构建输出（`dist/*`）和生产安装。
- Mac 打包（开发）：`scripts/package-mac-app.sh` 默认使用当前架构。发布清单：`docs/platforms/mac/release.md`。
- 类型检查/构建：`pnpm build`
- TypeScript 检查：`pnpm tsgo`
- 代码检查/格式化：`pnpm check`
- 格式检查：`pnpm format`（oxfmt --check）
- 格式修复：`pnpm format:fix`（oxfmt --write）
- 测试：`pnpm test`（vitest）；覆盖率：`pnpm test:coverage`

## 代码风格与命名规范

- 语言：TypeScript（ESM）。优先使用严格类型；避免 `any`。
- 通过 Oxlint 和 Oxfmt 进行格式化/代码检查；提交前运行 `pnpm check`。
- 禁止添加 `@ts-nocheck`，不要禁用 `no-explicit-any`；修复根本原因，仅在必要时更新 Oxlint/Oxfmt 配置。
- 禁止通过原型变异共享类行为（`applyPrototypeMixins`、在 `.prototype` 上使用 `Object.defineProperty`，或导出 `Class.prototype` 进行合并）。使用显式继承/组合（`A extends B extends C`）或辅助组合，以便 TypeScript 能进行类型检查。
- 如果需要此模式，停下来并在发布前获得明确批准；默认行为是拆分/重构为显式类层次结构并保持成员强类型。
- 在测试中，优先使用每个实例的桩函数，而非原型变异（`SomeClass.prototype.method = ...`），除非测试明确记录了为何需要原型级补丁。
- 为复杂或不明显的逻辑添加简短代码注释。
- 保持文件简洁；提取辅助函数而非创建"V2"副本。对 CLI 选项和通过 `createDefaultDeps` 进行依赖注入使用现有模式。
- 目标是将文件保持在约 700 行以内；仅为指导原则（非硬性限制）。当有助于提高清晰度或可测试性时进行拆分/重构。
- 命名：产品/应用/文档标题使用 **OpenClaw**；CLI 命令、包/二进制文件、路径和配置键使用 `openclaw`。

## 发布渠道（命名）

- stable：仅限标记发布（例如 `vYYYY.M.D`），npm dist-tag 为 `latest`。
- beta：预发布标签 `vYYYY.M.D-beta.N`，npm dist-tag 为 `beta`（可能不包含 macOS 应用）。
- beta 命名：优先使用 `-beta.N`；不要创建新的 `-1/-2` beta。历史遗留的 `vYYYY.M.D-<patch>` 和 `vYYYY.M.D.beta.N` 保持可识别。
- dev：`main` 分支上的移动头（无标签；git checkout main）。

## 测试指南

- 框架：Vitest，V8 覆盖率阈值（行/分支/函数/语句各 70%）。
- 命名：与源文件名匹配，使用 `*.test.ts`；端到端测试使用 `*.e2e.test.ts`。
- 修改逻辑后推送前运行 `pnpm test`（或 `pnpm test:coverage`）。
- 不要将测试工作进程设置超过 16；已尝试过。
- 如果本地 Vitest 运行导致内存压力（非 Mac-Studio 主机常见），使用 `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test` 进行落地/门控运行。
- 真实密钥的线上测试：`CLAWDBOT_LIVE_TEST=1 pnpm test:live`（仅 OpenClaw）或 `LIVE=1 pnpm test:live`（包含提供者线上测试）。Docker：`pnpm test:docker:live-models`、`pnpm test:docker:live-gateway`。入门引导 Docker E2E：`pnpm test:docker:onboard`。
- 完整套件及覆盖内容：`docs/testing.md`。
- 变更日志：仅记录面向用户的更改；不记录内部/元注释（版本对齐、appcast 提醒、发布流程）。
- 纯测试添加/修复通常**不需要**变更日志条目，除非它们改变了面向用户的行为或用户明确要求。
- 移动端：使用模拟器之前，检查已连接的真实设备（iOS + Android），优先使用真实设备。

## 提交与 Pull Request 指南

**完整维护者 PR 工作流（可选）：** 如果需要仓库的端到端维护者工作流（分级顺序、质量标准、rebase 规则、提交/变更日志规范、共同贡献者政策，以及 `review-pr` > `prepare-pr` > `merge-pr` 流水线），请参见 `.agents/skills/PR_WORKFLOW.md`。维护者可以使用其他工作流；当维护者指定了工作流时，遵循该工作流。如果未指定工作流，默认使用 PR_WORKFLOW。

- 使用 `scripts/committer "<msg>" <file...>` 创建提交；避免手动使用 `git add`/`git commit`，以保持暂存范围有限。
- 遵循简洁、面向操作的提交信息（例如：`CLI: add verbose flag to send`）。
- 将相关更改分组；避免将无关重构捆绑在一起。
- PR 提交模板（规范）：`.github/pull_request_template.md`
- Issue 提交模板（规范）：`.github/ISSUE_TEMPLATE/`

## 简写命令

- `sync`：如果工作树有脏文件，提交所有更改（选择合理的 Conventional Commit 消息），然后 `git pull --rebase`；如果有 rebase 冲突且无法解决，停止；否则 `git push`。

## Git 注意事项

- 如果 `git branch -d/-D <branch>` 被策略阻止，直接删除本地引用：`git update-ref -d refs/heads/<branch>`。
- 批量 PR 关闭/重开安全：如果关闭操作会影响超过 5 个 PR，先请求用户明确确认，包含确切的 PR 数量和目标范围/查询。

## GitHub 搜索（`gh`）

- 在提出新工作或重复修复之前，优先进行定向关键词搜索。
- 首先使用 `--repo openclaw/openclaw` + `--match title,body`；分级后续线程时添加 `--match comments`。
- PR：`gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"`
- Issues：`gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"`
- 结构化输出示例：
  `gh search issues --repo openclaw/openclaw --match title,body --limit 50 --json number,title,state,url,updatedAt -- "auto update" --jq '.[] | "\(.number) | \(.state) | \(.title) | \(.url)"'`

## 安全与配置提示

- Web 提供者将凭据存储在 `~/.openclaw/credentials/`；如已登出，重新运行 `openclaw login`。
- Pi 会话默认位于 `~/.openclaw/sessions/`；基目录不可配置。
- 环境变量：参见 `~/.profile`。
- 绝不提交或发布真实的电话号码、视频或实时配置值。在文档、测试和示例中使用明显的虚假占位符。
- 发布流程：任何发布工作前，始终阅读 `docs/reference/RELEASING.md` 和 `docs/platforms/mac/release.md`；一旦这些文档解答了常规问题，就不要再追问。

## GHSA（仓库安全公告）补丁/发布

- 审查安全公告之前，阅读 `SECURITY.md`。
- 获取：`gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`
- 最新 npm 版本：`npm view openclaw version --userconfig "$(mktemp)"`
- 私有 fork 的 PR 必须已关闭：
  `fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)`
  `gh pr list -R "$fork" --state open`（必须为空）
- 描述换行陷阱：通过 heredoc 将 Markdown 写入 `/tmp/ghsa.desc.md`（不使用 `"\\n"` 字符串）
- 通过 jq 构建补丁 JSON：`jq -n --rawfile desc /tmp/ghsa.desc.md '{summary,severity,description:$desc,vulnerabilities:[...]}' > /tmp/ghsa.patch.json`
- GHSA API 陷阱：不能在同一个 PATCH 中同时设置 `severity` 和 `cvss_vector_string`；需分开调用。
- 补丁 + 发布：`gh api -X PATCH /repos/openclaw/openclaw/security-advisories/<GHSA> --input /tmp/ghsa.patch.json`（发布 = 包含 `"state":"published"`；没有 `/publish` 端点）
- 如果发布失败（HTTP 422）：`severity`/`description`/`vulnerabilities[]` 缺失，或私有 fork 有未关闭的 PR
- 验证：重新获取；确保 `state=published`，`published_at` 已设置；`jq -r .description | rg '\\\\n'` 返回空

## 故障排除

- 品牌重塑/迁移问题或遗留配置/服务警告：运行 `openclaw doctor`（参见 `docs/gateway/doctor.md`）。

## Agent 专属说明

- 词汇："makeup" = "mac app"（Mac 应用）。
- 绝不编辑 `node_modules`（全局/Homebrew/npm/git 安装也不行）。更新会覆盖内容。Skill 说明放在 `tools.md` 或 `AGENTS.md` 中。
- 在仓库任意位置添加新 `AGENTS.md` 时，同时添加指向它的 `CLAUDE.md` 符号链接（示例：`ln -s AGENTS.md CLAUDE.md`）。
- Signal："update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` 然后 `fly machines restart e825232f34d058 -a flawd-bot`。
- 处理 GitHub Issue 或 PR 时，在任务结束时打印完整 URL。
- 回答问题时，仅给出高置信度答案：在代码中验证；不要猜测。
- 绝不更新 Carbon 依赖。
- `pnpm.patchedDependencies` 中的任何依赖必须使用精确版本（不带 `^`/`~`）。
- 修补依赖（pnpm patches、overrides 或 vendored 更改）需要明确批准；默认不这样做。
- CLI 进度：使用 `src/cli/progress.ts`（`osc-progress` + `@clack/prompts` spinner）；不要手动实现 spinner/进度条。
- 状态输出：保持表格 + ANSI 安全换行（`src/terminal/table.ts`）；`status --all` = 只读/可粘贴，`status --deep` = 探测。
- 网关目前仅作为菜单栏应用运行；没有单独安装的 LaunchAgent/helper 标签。通过 OpenClaw Mac 应用或 `scripts/restart-mac.sh` 重启；要验证/终止，使用 `launchctl print gui/$UID | grep openclaw`，而不是假设固定标签。**在 macOS 上调试时，通过应用启动/停止网关，而不是临时 tmux 会话；移交前终止所有临时隧道。**
- macOS 日志：使用 `./scripts/clawlog.sh` 查询 OpenClaw 子系统的统一日志；支持 follow/tail/category 过滤器，需要对 `/usr/bin/log` 无密码 sudo。
- 如果共享护栏在本地可用，请审查；否则遵循本仓库指南。
- SwiftUI 状态管理（iOS/macOS）：优先使用 `Observation` 框架（`@Observable`、`@Bindable`），而非 `ObservableObject`/`@StateObject`；除非兼容性需要，不要引入新的 `ObservableObject`，并在修改相关代码时迁移现有用法。
- 连接提供者：添加新连接时，更新每个 UI 界面和文档（macOS 应用、Web UI、移动端（如适用）、入门引导/概览文档），并添加匹配的状态 + 配置表单，以保持提供者列表和设置同步。
- 版本位置：`package.json`（CLI）、`apps/android/app/build.gradle.kts`（versionName/versionCode）、`apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist`（CFBundleShortVersionString/CFBundleVersion）、`apps/macos/Sources/OpenClaw/Resources/Info.plist`（CFBundleShortVersionString/CFBundleVersion）、`docs/install/updating.md`（固定 npm 版本）、`docs/platforms/mac/release.md`（APP_VERSION/APP_BUILD 示例）、Peekaboo Xcode 项目/Info.plists（MARKETING_VERSION/CURRENT_PROJECT_VERSION）。
- "全面更新版本号"意味着上述所有版本位置，**除了** `appcast.xml`（只有在发布新 macOS Sparkle 版本时才修改 appcast）。
- **重启应用：** "重启 iOS/Android 应用"意味着重新构建（重新编译/安装）并重新启动，而不仅仅是终止/启动。
- **设备检查：** 测试前，优先查找已连接的真实设备（iOS/Android），然后再使用模拟器/仿真器。
- iOS Team ID 查找：`security find-identity -p codesigning -v` → 使用 Apple Development (…) TEAMID。备选：`defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`。
- A2UI bundle hash：`src/canvas-host/a2ui/.bundle.hash` 是自动生成的；忽略意外更改，仅在需要时通过 `pnpm canvas:a2ui:bundle`（或 `scripts/bundle-a2ui.sh`）重新生成。将 hash 作为单独的提交提交。
- 发布签名/公证密钥在仓库外管理；遵循内部发布文档。
- 公证认证环境变量（`APP_STORE_CONNECT_ISSUER_ID`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_API_KEY_P8`）应在你的环境中（按内部发布文档）。
- **多代理安全：** 除非明确请求，否则**不**创建/应用/删除 `git stash` 条目（包括 `git pull --rebase --autostash`）。假设其他代理可能在工作；保持无关的 WIP 不变，避免跨领域状态更改。
- **多代理安全：** 当用户说"push"时，可以 `git pull --rebase` 整合最新更改（绝不丢弃其他代理的工作）。当用户说"commit"时，仅提交你的更改。当用户说"commit all"时，分组提交所有内容。
- **多代理安全：** 除非明确请求，否则**不**创建/删除/修改 `git worktree` 检出（或编辑 `.worktrees/*`）。
- **多代理安全：** 除非明确请求，否则**不**切换分支/检出不同分支。
- **多代理安全：** 运行多个代理是可以的，只要每个代理有自己的会话。
- **多代理安全：** 看到无法识别的文件时，继续工作；专注于你的更改，只提交那些内容。
- 代码检查/格式化混乱：
  - 如果暂存+未暂存的差异仅为格式化，无需询问，自动解决。
  - 如果已请求提交/推送，自动暂存并将仅格式化的后续更改包含在同一提交中（或如需要，一个小的后续提交），无需额外确认。
  - 仅在更改是语义性的（逻辑/数据/行为）时才询问。
- Lobster 接口：使用 `src/terminal/palette.ts` 中的共享 CLI 调色板（不硬编码颜色）；根据需要将调色板应用于入门引导/配置提示和其他 TTY UI 输出。
- **多代理安全：** 报告聚焦于你的编辑；避免护栏免责声明，除非真正被阻塞；当多个代理接触同一文件时，如果安全则继续；仅在相关时以简短的"其他文件存在"说明结束。
- Bug 调查：在得出结论之前，阅读相关 npm 依赖项的源代码和所有相关本地代码；以高置信度根本原因为目标。
- 代码风格：为复杂逻辑添加简短注释；在可行时将文件保持在约 500 行以内（根据需要拆分/重构）。
- 工具模式护栏（google-antigravity）：避免在工具输入模式中使用 `Type.Union`；不使用 `anyOf`/`oneOf`/`allOf`。对字符串列表使用 `stringEnum`/`optionalStringEnum`（Type.Unsafe enum），使用 `Type.Optional(...)` 代替 `... | null`。将顶级工具模式保持为带 `properties` 的 `type: "object"`。
- 工具模式护栏：避免在工具模式中使用原始 `format` 属性名；某些验证器将 `format` 视为保留关键字并拒绝模式。
- 当被要求打开"会话"文件时，打开 `~/.openclaw/agents/<agentId>/sessions/*.jsonl` 下的 Pi 会话日志（使用系统提示 Runtime 行中的 `agent=<id>` 值；除非指定了特定 ID，否则使用最新的），而不是默认的 `sessions.json`。如果需要来自另一台机器的日志，通过 Tailscale SSH 并在那里读取相同路径。
- 不要通过 SSH 重建 macOS 应用；重建必须直接在 Mac 上运行。
- 绝不向外部消息界面（WhatsApp、Telegram）发送流式/部分回复；只有最终回复才应发送到那里。流式/工具事件仍可发送到内部 UI/控制频道。
- 语音唤醒转发提示：
  - 命令模板应保持为 `openclaw-mac agent --message "${text}" --thinking low`；`VoiceWakeForwarder` 已对 `${text}` 进行 shell 转义。不要添加额外引号。
  - launchd PATH 是最小化的；确保应用的 launch agent PATH 包含标准系统路径以及你的 pnpm bin（通常是 `$HOME/Library/pnpm`），以便通过 `openclaw-mac` 调用时 `pnpm`/`openclaw` 二进制文件可以解析。
- 对于包含 `!` 的手动 `openclaw message send` 消息，使用下面提到的 heredoc 模式以避免 Bash 工具的转义问题。
- 发布护栏：未经操作员明确同意，不要更改版本号；在运行任何 npm publish/发布步骤之前，始终请求许可。
- Beta 发布护栏：使用 beta Git 标签时（例如 `vYYYY.M.D-beta.N`），发布 npm 时使用匹配的 beta 版本后缀（例如 `YYYY.M.D-beta.N`），而不是在 `--tag beta` 上使用普通版本名；否则普通版本名会被占用/阻塞。

## NPM + 1Password（发布/验证）

- 使用 1password skill；所有 `op` 命令必须在新 tmux 会话中运行。
- 登录：`eval "$(op signin --account my.1password.com)"`（应用已解锁 + 集成已开启）。
- OTP：`op read 'op://Private/Npmjs/one-time password?attribute=otp'`。
- 发布：`npm publish --access public --otp="<otp>"`（从包目录运行）。
- 不产生本地 npmrc 副作用的验证：`npm view <pkg> version --userconfig "$(mktemp)"`。
- 发布后终止 tmux 会话。

## 插件快速发布路径（不发布核心 `openclaw`）

- 仅发布已在 npm 上的插件。来源列表在 `docs/reference/RELEASING.md` 的"Current npm plugin list"下。
- 在 tmux 内运行所有 CLI `op` 调用和 `npm publish`，以避免挂起/中断：
  - `tmux new -d -s release-plugins-$(date +%Y%m%d-%H%M%S)`
  - `eval "$(op signin --account my.1password.com)"`
- 1Password 助手：
  - `npm login` 使用的密码：
    `op item get Npmjs --format=json | jq -r '.fields[] | select(.id=="password").value'`
  - OTP：
    `op read 'op://Private/Npmjs/one-time password?attribute=otp'`
- 快速发布循环（本地辅助脚本放 `/tmp` 即可；保持仓库干净）：
  - 比较本地插件 `version` 与 `npm view <name> version`
  - 仅当版本不同时运行 `npm publish --access public --otp="<otp>"`
  - 如果包在 npm 上不存在或版本已匹配，则跳过。
- 保持 `openclaw` 不变：除非明确请求，否则绝不从仓库根目录运行 publish。
- 每次发布后的检查：
  - 每个插件：`npm view @openclaw/<name> version --userconfig "$(mktemp)"` 应为 `2026.2.17`
  - 核心守护：`npm view openclaw version --userconfig "$(mktemp)"` 应保持在之前的版本，除非明确请求。

## 变更日志发布说明

- 发布带有 beta GitHub 预发布的 Mac 版本时：
  - 从发布提交打标签 `vYYYY.M.D-beta.N`（示例：`v2026.2.15-beta.1`）。
  - 创建标题为 `openclaw YYYY.M.D-beta.N` 的预发布。
  - 使用 `CHANGELOG.md` 版本章节中的发布说明（`Changes` + `Fixes`，不重复标题）。
  - 至少附加 `OpenClaw-YYYY.M.D.zip` 和 `OpenClaw-YYYY.M.D.dSYM.zip`；如有 `.dmg` 则一并包含。

- 保持 `CHANGELOG.md` 顶部版本条目按影响程度排序：
  - 先是 `### Changes`。
  - `### Fixes` 去重并排序，面向用户的修复优先。
- 打标签/发布前，运行：
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `pnpm test:install:smoke` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（非 root 冒烟路径）。
