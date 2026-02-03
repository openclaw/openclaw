---
read_when:
  - 发布新的 npm 版本时
  - 发布新的 macOS 应用版本时
  - 发布前验证元数据时
summary: npm + macOS 应用的分步发布检查清单
x-i18n:
  generated_at: "2026-02-01T21:37:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 97c911cf70a0b98838d871cb99826b99f3da63295a744f412e3c05021363a7b5
  source_path: reference/RELEASING.md
  workflow: 15
---

# 发布检查清单（npm + macOS）

从仓库根目录使用 `pnpm`（Node 22+）。在打标签/发布前确保工作区干净。

## 操作员触发

当操作员说"发布"时，立即执行以下预检（除非被阻塞，否则不要多问）：

- 阅读本文档和 `docs/platforms/mac/release.md`。
- 从 `~/.profile` 加载环境变量，确认 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 变量已设置（SPARKLE_PRIVATE_KEY_FILE 应位于 `~/.profile` 中）。
- 如需要，使用 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 中的 Sparkle 密钥。

1. **版本与元数据**

- [ ] 更新 `package.json` 版本号（例如 `2026.1.29`）。
- [ ] 运行 `pnpm plugins:sync` 以同步扩展包版本 + 变更日志。
- [ ] 更新 CLI/版本字符串：[`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 和 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) 中的 Baileys user agent。
- [ ] 确认包元数据（name、description、repository、keywords、license）以及 `bin` 映射指向 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) 对应 `openclaw`。
- [ ] 如果依赖有变更，运行 `pnpm install` 确保 `pnpm-lock.yaml` 是最新的。

2. **构建与产物**

- [ ] 如果 A2UI 输入有变更，运行 `pnpm canvas:a2ui:bundle` 并提交更新后的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。
- [ ] `pnpm run build`（重新生成 `dist/`）。
- [ ] 验证 npm 包的 `files` 包含所有必需的 `dist/*` 文件夹（特别是 `dist/node-host/**` 和 `dist/acp/**`，用于无界面 node + ACP CLI）。
- [ ] 确认 `dist/build-info.json` 存在并包含预期的 `commit` 哈希（CLI 横幅在 npm 安装时使用此信息）。
- [ ] 可选：构建后运行 `npm pack --pack-destination /tmp`；检查 tarball 内容并保留用于 GitHub 发布（**不要**提交它）。

3. **变更日志与文档**

- [ ] 更新 `CHANGELOG.md`，包含面向用户的重点内容（如文件不存在则创建）；条目按版本严格降序排列。
- [ ] 确保 README 中的示例/参数与当前 CLI 行为一致（特别是新命令或选项）。

4. **验证**

- [ ] `pnpm lint`
- [ ] `pnpm test`（如需覆盖率输出则使用 `pnpm test:coverage`）
- [ ] `pnpm run build`（测试后的最终安装完整性检查）
- [ ] `pnpm release:check`（验证 npm pack 内容）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker 安装冒烟测试，快速路径；发布前必须执行）
  - 如果已知上一个 npm 发布版本有问题，为预安装步骤设置 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。
- [ ] （可选）完整安装冒烟测试（增加非 root + CLI 覆盖）：`pnpm test:install:smoke`
- [ ] （可选）安装端到端测试（Docker，运行 `curl -fsSL https://openclaw.ai/install.sh | bash`，执行新手引导，然后运行真实工具调用）：
  - `pnpm test:install:e2e:openai`（需要 `OPENAI_API_KEY`）
  - `pnpm test:install:e2e:anthropic`（需要 `ANTHROPIC_API_KEY`）
  - `pnpm test:install:e2e`（需要两个密钥；运行两个提供商）
- [ ] （可选）如果你的更改影响了发送/接收路径，抽查 Web Gateway网关。

5. **macOS 应用（Sparkle）**

- [ ] 构建 + 签名 macOS 应用，然后打包为 zip 用于分发。
- [ ] 生成 Sparkle appcast（通过 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 生成 HTML 说明）并更新 `appcast.xml`。
- [ ] 保留应用 zip（和可选的 dSYM zip）以附加到 GitHub 发布。
- [ ] 按照 [macOS 发布](/platforms/mac/release) 获取确切的命令和所需的环境变量。
  - `APP_BUILD` 必须是数字且单调递增（不含 `-beta`），以便 Sparkle 正确比较版本。
  - 如果进行公证，使用从 App Store Connect API 环境变量创建的 `openclaw-notary` 钥匙串配置文件（参见 [macOS 发布](/platforms/mac/release)）。

6. **发布（npm）**

- [ ] 确认 git 状态干净；按需提交并推送。
- [ ] 如需要，`npm login`（验证 2FA）。
- [ ] `npm publish --access public`（预发布版本使用 `--tag beta`）。
- [ ] 验证注册表：`npm view openclaw version`、`npm view openclaw dist-tags` 和 `npx -y openclaw@X.Y.Z --version`（或 `--help`）。

### 故障排除（来自 2.0.0-beta2 发布的经验）

- **npm pack/publish 挂起或生成巨大的 tarball**：`dist/OpenClaw.app` 中的 macOS 应用包（和发布 zip）被包含进了包中。通过 `package.json` 的 `files` 白名单发布内容来修复（包含 dist 子目录、docs、skills；排除应用包）。使用 `npm pack --dry-run` 确认 `dist/OpenClaw.app` 未被列出。
- **npm auth 在 dist-tags 操作时进入 web 循环**：使用传统认证以获取 OTP 提示：
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 验证失败并报 `ECOMPROMISED: Lock compromised`**：使用新缓存重试：
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **延迟修复后需要重新指向标签**：强制更新并推送标签，然后确保 GitHub 发布资产仍然匹配：
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 发布 + appcast**

- [ ] 打标签并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（或 `git push --tags`）。
- [ ] 为 `vX.Y.Z` 创建/更新 GitHub 发布，**标题为 `openclaw X.Y.Z`**（不仅仅是标签）；正文应包含该版本的**完整**变更日志部分（亮点 + 变更 + 修复），内联展示（不使用裸链接），且**正文中不得重复标题**。
- [ ] 附加产物：`npm pack` tarball（可选）、`OpenClaw-X.Y.Z.zip` 和 `OpenClaw-X.Y.Z.dSYM.zip`（如已生成）。
- [ ] 提交更新后的 `appcast.xml` 并推送（Sparkle 从 main 分支获取）。
- [ ] 从一个干净的临时目录（无 `package.json`）运行 `npx -y openclaw@X.Y.Z send --help` 以确认安装/CLI 入口点正常工作。
- [ ] 发布/分享发布说明。

## 插件发布范围（npm）

我们只发布 `@openclaw/*` 作用域下的**现有 npm 插件**。未上架 npm 的内置插件仅保留为**磁盘目录形式**（仍通过 `extensions/**` 分发）。

确定列表的流程：

1. `npm search @openclaw --json` 并记录包名。
2. 与 `extensions/*/package.json` 中的名称进行比较。
3. 只发布**交集部分**（已在 npm 上的）。

当前 npm 插件列表（按需更新）：

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

发布说明还必须标注**新的可选内置插件**，这些插件**默认未启用**（例如：`tlon`）。
