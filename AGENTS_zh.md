# 仓库指南

- 仓库：https://github.com/openclaw/openclaw
- 在聊天回复中，文件引用必须仅相对于仓库根目录（例如：`extensions/bluebubbles/src/channel.ts:80`）；绝不能使用绝对路径或 `~/...`。
- GitHub 问题/评论/PR 评论：对真正的换行符使用字面多行字符串或 `-F - <<'EOF'` (或 $'...'); 绝不嵌入“\\n”。
- GitHub 评论陷阱：当正文包含反引号或 shell 字符时，切勿使用 `gh issue/pr comment -b "..."`。始终使用单引号 heredoc (`-F - <<'EOF'`)，以免命令替换/转义损坏。
- GitHub 链接陷阱：当您想要自动链接时，不要将 `#24643` 之类的问题/PR 引用包装在反引号中。使用纯文本 `#24643`（可选择添加完整 URL）。
- 安全公告分析：在进行分类/严重性决策之前，请阅读 `SECURITY.md` 以符合 OpenClaw 的信任模型和设计边界。

## 项目结构和模块组织

- 源代码：`src/`（`src/cli` 中的 CLI 连接，`src/commands` 中的命令，`src/provider-web.ts` 中的 Web 提供程序，`src/infra` 中的基础结构，`src/media` 中的媒体管道）。
- 测试：并置的 `*.test.ts`。
- 文档：`docs/`（图像、队列、Pi 配置）。构建输出位于 `dist/` 中。
- 插件/扩展：位于 `extensions/*`（工作区包）下。将仅插件的依赖项保留在扩展 `package.json` 中；除非核心使用它们，否则不要将它们添加到根 `package.json`。
- 插件：安装在插件目录中运行 `npm install --omit=dev`；运行时依赖项必须位于 `dependencies` 中。避免在 `dependencies` 中使用 `workspace:*`（npm install 会中断）；而是将 `openclaw` 放在 `devDependencies` 或 `peerDependencies` 中（运行时通过 jiti 别名解析 `openclaw/plugin-sdk`）。
- 从 `https://openclaw.ai/*` 提供的安装程序：位于同级仓库 `../openclaw.ai`（`public/install.sh`、`public/install-cli.sh`、`public/install.ps1`）中。
- 消息通道：在重构共享逻辑（路由、允许列表、配对、命令门控、入门、文档）时，请始终考虑**所有**内置+扩展通道。
  - 核心通道文档：`docs/channels/`
  - 核心通道代码：`src/telegram`、`src/discord`、`src/slack`、`src/signal`、`src/imessage`、`src/web`（WhatsApp web）、`src/channels`、`src/routing`
  - 扩展（通道插件）：`extensions/*`（例如 `extensions/msteams`、`extensions/matrix`、`extensions/zalo`、`extensions/zalouser`、`extensions/voice-call`）
- 添加通道/扩展/应用程序/文档时，更新 `.github/labeler.yml` 并创建匹配的 GitHub 标签（使用现有的通道/扩展标签颜色）。

## 文档链接 (Mintlify)

- 文档托管在 Mintlify (docs.openclaw.ai) 上。
- `docs/**/*.md` 中的内部文档链接：相对于根目录，不带 `.md`/`.mdx`（例如：`[Config](/configuration)`）。
- 使用文档时，请阅读 mintlify 技能。
- 节交叉引用：在相对于根目录的路径上使用锚点（例如：`[Hooks](/configuration#hooks)`）。
- 文档标题和锚点：避免在标题中使用破折号和撇号，因为它们会破坏 Mintlify 锚点链接。
- 当 Peter 要求提供链接时，请使用完整的 `https://docs.openclaw.ai/...` URL 回复（而不是相对于根目录）。
- 当您接触文档时，请在回复末尾附上您引用的 `https://docs.openclaw.ai/...` URL。
- README (GitHub)：保留绝对文档 URL (`https://docs.openclaw.ai/...`)，以便链接在 GitHub 上正常工作。
- 文档内容必须是通用的：没有个人设备名称/主机名/路径；使用占位符，如 `user@gateway-host` 和“网关主机”。

## 文档 i18n (zh-CN)

- `docs/zh-CN/**` 是生成的；除非用户明确要求，否则不要编辑。
- 管道：更新英文文档 → 调整词汇表 (`docs/.i18n/glossary.zh-CN.json`) → 运行 `scripts/docs-i18n` → 仅在有指示时应用有针对性的修复。
- 翻译记忆库：`docs/.i18n/zh-CN.tm.jsonl`（生成的）。
- 请参阅 `docs/.i18n/README.md`。
- 管道可能缓慢/低效；如果它拖慢了速度，请在 Discord 上 ping @jospalmbier，而不是自己动手解决。

## exe.dev VM 操作（常规）

- 访问：稳定路径是 `ssh exe.dev` 然后 `ssh vm-name`（假设 SSH 密钥已设置）。
- SSH 不稳定：使用 exe.dev Web 终端或 Shelley（Web 代理）；为长时间操作保留一个 tmux 会话。
- 更新：`sudo npm i -g openclaw@latest`（全局安装需要在 `/usr/lib/node_modules` 上具有 root 权限）。
- 配置：使用 `openclaw config set ...`；确保设置了 `gateway.mode=local`。
- Discord：仅存储原始令牌（不带 `DISCORD_BOT_TOKEN=` 前缀）。
- 重启：停止旧网关并运行：
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- 验证：`openclaw channels status --probe`、`ss -ltnp | rg 18789`、`tail -n 120 /tmp/openclaw-gateway.log`。

## 构建、测试和开发命令

- 运行时基线：Node **22+**（保持 Node + Bun 路径正常工作）。
- 安装依赖项：`pnpm install`
- 如果缺少依赖项（例如缺少 `node_modules`、找不到 `vitest` 或找不到命令），请运行仓库的包管理器安装命令（首选 lockfile/README 定义的 PM），然后再次重新运行确切的请求命令。将此应用于测试/构建/lint/类型检查/开发命令；如果重试仍然失败，请报告命令和第一个可操作的错误。
- 预提交挂钩：`prek install`（运行与 CI 相同的检查）
- 还支持：`bun install`（在接触依赖项/补丁时保持 `pnpm-lock.yaml` + Bun 补丁同步）。
- 首选 Bun 执行 TypeScript（脚本、开发、测试）：`bun <file.ts>` / `bunx <tool>`。
- 在开发中运行 CLI：`pnpm openclaw ...` (bun) 或 `pnpm dev`。
- Node 仍然支持运行构建输出 (`dist/*`) 和生产安装。
- Mac 打包（开发）：`scripts/package-mac-app.sh` 默认为当前体系结构。发布清单：`docs/platforms/mac/release.md`。
- 类型检查/构建：`pnpm build`
- TypeScript 检查：`pnpm tsgo`
- Lint/格式化：`pnpm check`
- 格式检查：`pnpm format` (oxfmt --check)
- 格式修复：`pnpm format:fix` (oxfmt --write)
- 测试：`pnpm test` (vitest)；覆盖率：`pnpm test:coverage`

## 编码风格和命名约定

- 语言：TypeScript (ESM)。首选严格类型；避免 `any`。
- 通过 Oxlint 和 Oxfmt 进行格式化/linting；在提交前运行 `pnpm check`。
- 切勿添加 `@ts-nocheck` 并且不要禁用 `no-explicit-any`；修复根本原因并仅在需要时更新 Oxlint/Oxfmt 配置。
- 切勿通过原型突变共享类行为（`applyPrototypeMixins`、在 `.prototype` 上使用 `Object.defineProperty` 或导出 `Class.prototype` 进行合并）。使用显式继承/组合（`A extends B extends C`）或辅助组合，以便 TypeScript 可以进行类型检查。
- 如果需要此模式，请在发布前停止并获得明确批准；默认行为是拆分/重构为显式类层次结构并保持成员强类型。
- 在测试中，首选每个实例的存根而不是原型突变（`SomeClass.prototype.method = ...`），除非测试明确说明为什么需要原型级别的修补。
- 为棘手或不明显的逻辑添加简短的代码注释。
- 保持文件简洁；提取辅助函数而不是“V2”副本。使用现有模式进行 CLI 选项和通过 `createDefaultDeps` 进行依赖注入。
- 目标是使文件保持在约 700 行代码以下；仅为指导原则（不是硬性规定）。当可以提高清晰度或可测试性时进行拆分/重构。
- 命名：对产品/应用/文档标题使用 **OpenClaw**；对 CLI 命令、包/二进制文件、路径和配置键使用 `openclaw`。

## 发布渠道（命名）

- 稳定版：仅标记版本（例如 `vYYYY.M.D`），npm dist-tag `latest`。
- 测试版：预发布标签 `vYYYY.M.D-beta.N`，npm dist-tag `beta`（可能在没有 macOS 应用的情况下发布）。
- 测试版命名：首选 `-beta.N`；不要创建新的 `-1/-2` 测试版。旧版 `vYYYY.M.D-<patch>` 和 `vYYYY.M.D.beta.N` 仍然被识别。
- 开发版：`main` 上的移动头（无标签；git checkout main）。

## 测试指南

- 框架：Vitest，V8 覆盖率阈值为 70%（行/分支/函数/语句）。
- 命名：将源名称与 `*.test.ts` 匹配；e2e 在 `*.e2e.test.ts` 中。
- 在接触逻辑时，在推送前运行 `pnpm test`（或 `pnpm test:coverage`）。
- 不要将测试工作线程数设置在 16 以上；已经尝试过了。
- 如果本地 Vitest 运行导致内存压力（在非 Mac-Studio 主机上很常见），请使用 `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test` 进行 land/gate 运行。
- 实时测试（真实密钥）：`CLAWDBOT_LIVE_TEST=1 pnpm test:live`（仅限 OpenClaw）或 `LIVE=1 pnpm test:live`（包括提供商实时测试）。Docker：`pnpm test:docker:live-models`、`pnpm test:docker:live-gateway`。入门 Docker E2E：`pnpm test:docker:onboard`。
- 完整套件+涵盖内容：`docs/testing.md`。
- 变更日志：仅面向用户的更改；没有内部/元注释（版本对齐、appcast 提醒、发布过程）。
- 纯粹的测试添加/修复通常**不**需要变更日志条目，除非它们改变了面向用户的行为或用户要求。
- 移动端：在使用模拟器之前，请检查连接的真实设备（iOS + Android），并在可用时首选它们。

## 提交和拉取请求指南

**完整维护者 PR 工作流程（可选）：** 如果您想要仓库的端到端维护者工作流程（分类顺序、质量标准、变基规则、提交/变更日志约定、共同贡献者策略以及 `review-pr` > `prepare-pr` > `merge-pr` 管道），请参阅 `.agents/skills/PR_WORKFLOW.md`。维护者可以使用其他工作流程；当维护者指定工作流程时，请遵循该工作流程。如果未指定工作流程，则默认为 PR_WORKFLOW。

- 使用 `scripts/committer "<msg>" <file...>` 创建提交；避免手动 `git add`/`git commit`，以使暂存保持在范围内。
- 遵循简洁、面向操作的提交消息（例如，`CLI: add verbose flag to send`）。
- 分组相关更改；避免捆绑不相关的重构。
- PR 提交模板（规范）：`.github/pull_request_template.md`
- 问题提交模板（规范）：`.github/ISSUE_TEMPLATE/`

## 简写命令

- `sync`：如果工作树是脏的，则提交所有更改（选择一个合理的约定式提交消息），然后 `git pull --rebase`；如果变基冲突且无法解决，则停止；否则 `git push`。

## Git 注释

- 如果 `git branch -d/-D <branch>` 被策略阻止，请直接删除本地引用：`git update-ref -d refs/heads/<branch>`。
- 批量 PR 关闭/重新打开安全：如果关闭操作会影响超过 5 个 PR，请首先要求用户明确确认，并提供确切的 PR 数量和目标范围/查询。

## GitHub 搜索 (`gh`)

- 在提出新工作或重复修复之前，首选有针对性的关键字搜索。
- 首先使用 `--repo openclaw/openclaw` + `--match title,body`；在分类后续线程时添加 `--match comments`。
- PR：`gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"`
- 问题：`gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"`
- 结构化输出示例：
  `gh search issues --repo openclaw/openclaw --match title,body --limit 50 --json number,title,state,url,updatedAt -- "auto update" --jq '.[] | "\(.number) | \(.state) | \(.title) | \(.url)"'`

## 安全和配置提示

- Web 提供程序将凭据存储在 `~/.openclaw/credentials/`；如果已注销，请重新运行 `openclaw login`。
- Pi 会话默认位于 `~/.openclaw/sessions/` 下；基本目录不可配置。
- 环境变量：请参阅 `~/.profile`。
- 切勿提交或发布真实的电话号码、视频或实时配置值。在文档、测试和示例中使用明显虚假的占位符。
- 发布流程：在进行任何发布工作之前，请务必阅读 `docs/reference/RELEASING.md` 和 `docs/platforms/mac/release.md`；一旦这些文档回答了问题，就不要再问例行问题。

## GHSA（仓库公告）补丁/发布

- 在审查安全公告之前，请阅读 `SECURITY.md`。
- 获取：`gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`
- 最新 npm：`npm view openclaw version --userconfig "$(mktemp)"`
- 私有分支 PR 必须关闭：
  `fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)`
  `gh pr list -R "$fork" --state open`（必须为空）
- 描述换行陷阱：通过 heredoc 将 Markdown 写入 `/tmp/ghsa.desc.md`（不带 `"\\n"` 字符串）
- 通过 jq 构建补丁 JSON：`jq -n --rawfile desc /tmp/ghsa.desc.md '{summary,severity,description:$desc,vulnerabilities:[...]}' > /tmp/ghsa.patch.json`
- GHSA API 陷阱：无法在同一个 PATCH 中设置 `severity` 和 `cvss_vector_string`；请进行单独调用。
- 补丁 + 发布：`gh api -X PATCH /repos/openclaw/openclaw/security-advisories/<GHSA> --input /tmp/ghsa.patch.json`（发布 = 包括 `"state":"published"`；没有 `/publish` 端点）
- 如果发布失败 (HTTP 422)：缺少 `severity`/`description`/`vulnerabilities[]`，或者私有分支有打开的 PR
- 验证：重新获取；确保 `state=published`，`published_at` 已设置；`jq -r .description | rg '\\\\n'` 不返回任何内容

## 故障排除

- 品牌重塑/迁移问题或旧版配置/服务警告：运行 `openclaw doctor`（请参阅 `docs/gateway/doctor.md`）。

## 特定于代理的说明

- 词汇：“makeup” = “mac app”。
- 切勿编辑 `node_modules`（全局/Homebrew/npm/git 安装也是如此）。更新会覆盖。技能说明放在 `tools.md` 或 `AGENTS.md` 中。
- 在仓库中的任何位置添加新的 `AGENTS.md` 时，还要添加一个指向它的 `CLAUDE.md` 符号链接（例如：`ln -s AGENTS.md CLAUDE.md`）。
- Signal：“update fly” => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` 然后 `fly machines restart e825232f34d058 -a flawd-bot`。
- 在处理 GitHub 问题或 PR 时，请在任务结束时打印完整的 URL。
- 回答问题时，仅提供高置信度的答案：在代码中验证；不要猜测。
- 切勿更新 Carbon 依赖项。
- 任何带有 `pnpm.patchedDependencies` 的依赖项都必须使用确切的版本（没有 `^`/`~`）。
- 修补依赖项（pnpm 补丁、覆盖或供应商更改）需要明确批准；默认情况下不要这样做。
- CLI 进度：使用 `src/cli/progress.ts`（`osc-progress` + `@clack/prompts` 微调器）；不要手动编写微调器/进度条。
- 状态输出：保持表格 + ANSI 安全换行（`src/terminal/table.ts`）；`status --all` = 只读/可粘贴，`status --deep` = 探测。
- 网关当前仅作为菜单栏应用程序运行；没有安装单独的 LaunchAgent/帮助程序标签。通过 OpenClaw Mac 应用程序或 `scripts/restart-mac.sh` 重新启动；要验证/终止，请使用 `launchctl print gui/$UID | grep openclaw` 而不是假设固定的标签。**在 macOS 上调试时，通过应用程序启动/停止网关，而不是临时的 tmux 会话；在交接前终止任何临时隧道。**
- macOS 日志：使用 `./scripts/clawlog.sh` 查询 OpenClaw 子系统的统一日志；它支持 follow/tail/category 过滤器，并期望无密码 sudo 用于 `/usr/bin/log`。
- 如果本地有共享的护栏，请查看它们；否则请遵循此仓库的指导。
- SwiftUI 状态管理 (iOS/macOS)：首选 `Observation` 框架（`@Observable`、`@Bindable`）而不是 `ObservableObject`/`@StateObject`；除非为了兼容性而需要，否则不要引入新的 `ObservableObject`，并在接触相关代码时迁移现有用法。
- 连接提供程序：添加新连接时，更新每个 UI 界面和文档（macOS 应用程序、Web UI、移动设备（如果适用）、入门/概述文档），并添加匹配的状态 + 配置表单，以使提供程序列表和设置保持同步。
- 版本位置：`package.json` (CLI)、`apps/android/app/build.gradle.kts` (versionName/versionCode)、`apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion)、`apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion)、`docs/install/updating.md` (固定的 npm 版本)、`docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD 示例)、Peekaboo Xcode 项目/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION)。
- “随处更新版本”是指上述所有版本位置，**除了** `appcast.xml`（仅在发布新的 macOS Sparkle 版本时才接触 appcast）。
- **重新启动应用程序：**“重新启动 iOS/Android 应用程序”是指重建（重新编译/安装）和重新启动，而不仅仅是终止/启动。
- **设备检查：**在测试之前，请在接触模拟器/仿真器之前验证连接的真实设备（iOS/Android）。
- iOS Team ID 查找：`security find-identity -p codesigning -v` → 使用 Apple Development (…) TEAMID。备用方案：`defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`。
- A2UI 包哈希：`src/canvas-host/a2ui/.bundle.hash` 是自动生成的；忽略意外更改，并仅在需要时通过 `pnpm canvas:a2ui:bundle`（或 `scripts/bundle-a2ui.sh`）重新生成。将哈希作为单独的提交进行提交。
- 发布签名/公证密钥在仓库外部管理；遵循内部发布文档。
- 公证身份验证环境变量（`APP_STORE_CONNECT_ISSUER_ID`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_API_KEY_P8`）应在您的环境中（根据内部发布文档）。
- **多代理安全：**除非明确要求，否则**不要**创建/应用/删除 `git stash` 条目（这包括 `git pull --rebase --autostash`）。假设其他代理可能正在工作；保持不相关的 WIP 不变，并避免跨领域的状态更改。
- **多代理安全：**当用户说“推送”时，您可以 `git pull --rebase` 以集成最新更改（切勿丢弃其他代理的工作）。当用户说“提交”时，范围仅限于您的更改。当用户说“全部提交”时，将所有内容分组提交。
- **多代理安全：**除非明确要求，否则**不要**创建/删除/修改 `git worktree` 检出（或编辑 `.worktrees/*`）。
- **多代理安全：**除非明确要求，否则**不要**切换分支/检出不同的分支。
- **多代理安全：**只要每个代理都有自己的会话，就可以运行多个代理。
- **多代理安全：**当您看到无法识别的文件时，请继续；专注于您的更改并仅提交这些更改。
- Lint/格式流失：
  - 如果暂存+未暂存的差异仅为格式化，则自动解决而无需询问。
  - 如果已请求提交/推送，则自动暂存并将仅格式化的后续操作包含在同一提交中（或在需要时进行微小的后续提交），无需额外确认。
  - 仅当更改是语义性的（逻辑/数据/行为）时才询问。
- Lobster 接缝：在 `src/terminal/palette.ts` 中使用共享的 CLI 调色板（无硬编码颜色）；根据需要将调色板应用于入门/配置提示和其他 TTY UI 输出。
- **多代理安全：**将报告重点放在您的编辑上；除非真正受阻，否则避免使用护栏免责声明；当多个代理接触同一文件时，如果安全则继续；仅在相关时才以简短的“存在其他文件”注释结束。
- 错误调查：在得出结论之前，请阅读相关 npm 依赖项的源代码和所有相关的本地代码；旨在获得高置信度的根本原因。
- 代码风格：为棘手的逻辑添加简短的注释；在可行的情况下将文件保持在约 500 行代码以下（根据需要进行拆分/重构）。
- 工具模式护栏 (google-antigravity)：避免在工具输入模式中使用 `Type.Union`；没有 `anyOf`/`oneOf`/`allOf`。对字符串列表使用 `stringEnum`/`optionalStringEnum`（Type.Unsafe 枚举），并使用 `Type.Optional(...)` 而不是 `... | null`。将顶级工具模式保持为带有 `properties` 的 `type: "object"`。
- 工具模式护栏：避免在工具模式中使用原始 `format` 属性名称；一些验证器将 `format` 视为保留关键字并拒绝该模式。
- 当被要求打开“会话”文件时，请打开 `~/.openclaw/agents/<agentId>/sessions/*.jsonl` 下的 Pi 会话日志（使用系统提示符的 Runtime 行中的 `agent=<id>` 值；除非给出特定 ID，否则为最新），而不是默认的 `sessions.json`。如果需要从另一台计算机获取日志，请通过 Tailscale 进行 SSH 并在那里读取相同的路径。
- 不要通过 SSH 重建 macOS 应用程序；重建必须直接在 Mac 上运行。
- 切勿向外部消息传递界面（WhatsApp、Telegram）发送流式/部分回复；只有最终回复才应发送到那里。流式/工具事件仍可能发送到内部 UI/控制通道。
- 语音唤醒转发提示：
  - 命令模板应保持为 `openclaw-mac agent --message "${text}" --thinking low`；`VoiceWakeForwarder` 已经对 `${text}` 进行了 shell 转义。不要添加额外的引号。
  - launchd PATH 是最小的；确保应用程序的启动代理 PATH 包括标准系统路径以及您的 pnpm bin（通常为 `$HOME/Library/pnpm`），以便在通过 `openclaw-mac` 调用时解析 `pnpm`/`openclaw` 二进制文件。
- 对于包含 `!` 的手动 `openclaw message send` 消息，请使用下面提到的 heredoc 模式以避免 Bash 工具的转义。
- 发布护栏：未经操作员明确同意，请勿更改版本号；在运行任何 npm 发布/发布步骤之前，请务必征求许可。
- 测试版发布护栏：使用测试版 Git 标签（例如 `vYYYY.M.D-beta.N`）时，请使用匹配的测试版版本后缀（例如 `YYYY.M.D-beta.N`）发布 npm，而不是在 `--tag beta` 上使用普通版本；否则普通版本名称将被消耗/阻止。

## NPM + 1Password (发布/验证)

- 使用 1password 技能；所有 `op` 命令都必须在新的 tmux 会话中运行。
- 登录：`eval "$(op signin --account my.1password.com)"`（应用程序已解锁+集成已打开）。
- OTP：`op read 'op://Private/Npmjs/one-time password?attribute=otp'`。
- 发布：`npm publish --access public --otp="<otp>"`（从包目录运行）。
- 验证而不产生本地 npmrc 副作用：`npm view <pkg> version --userconfig "$(mktemp)"`。
- 发布后终止 tmux 会话。

## 插件发布快速通道（无核心 `openclaw` 发布）

- 仅发布已在 npm 上的插件。源列表位于 `docs/reference/RELEASING.md` 的“当前 npm 插件列表”下。
- 在 tmux 中运行所有 CLI `op` 调用和 `npm publish` 以避免挂起/中断：
  - `tmux new -d -s release-plugins-$(date +%Y%m%d-%H%M%S)`
  - `eval "$(op signin --account my.1password.com)"`
- 1Password 辅助函数：
  - `npm login` 使用的密码：
    `op item get Npmjs --format=json | jq -r '.fields[] | select(.id=="password").value'`
  - OTP：
    `op read 'op://Private/Npmjs/one-time password?attribute=otp'`
- 快速发布循环（`/tmp` 中的本地辅助脚本即可；保持仓库清洁）：
  - 将本地插件 `version` 与 `npm view <name> version` 进行比较
  - 仅当版本不同时才运行 `npm publish --access public --otp="<otp>"`
  - 如果包在 npm 上丢失或版本已匹配，则跳过。
- 保持 `openclaw` 不变：除非明确要求，否则切勿从仓库根目录运行发布。
- 每个版本的后置检查：
  - 每个插件：`npm view @openclaw/<name> version --userconfig "$(mktemp)"` 应为 `2026.2.17`
  - 核心防护：`npm view openclaw version --userconfig "$(mktemp)"` 应保持在先前版本，除非明确要求。

## 变更日志发布说明

- 使用 beta GitHub 预发布版本发布 mac 版本时：
  - 从发布提交中标记 `vYYYY.M.D-beta.N`（例如：`v2026.2.15-beta.1`）。
  - 创建标题为 `openclaw YYYY.M.D-beta.N` 的预发布版本。
  - 使用 `CHANGELOG.md` 版本部分中的发布说明（`更改` + `修复`，无标题重复）。
  - 至少附加 `OpenClaw-YYYY.M.D.zip` 和 `OpenClaw-YYYY.M.D.dSYM.zip`；如果可用，则包括 `.dmg`。

- 保持 `CHANGELOG.md` 中的顶级版本条目按影响排序：
  - `### 更改` 优先。
  - `### 修复` 已去重并按面向用户的修复优先排序。
- 在标记/发布之前，运行：
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `pnpm test:install:smoke` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` 用于非 root 冒烟路径。
