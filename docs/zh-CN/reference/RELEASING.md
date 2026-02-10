---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 发布新的 npm 版本（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 发布新的 macOS 应用版本（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 发布前验证元数据（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: npm + macOS 应用的逐步发布清单（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T10:09:28Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 1a684bc26665966eb3c9c816d58d18eead008fd710041181ece38c21c5ff1c62（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: reference/RELEASING.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 发布清单（npm + macOS）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
从仓库根目录使用 `pnpm`（Node 22+）。在打标签/发布前保持工作树干净。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 操作员触发（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
当操作员说"release"时，立即执行此预检（除非遇到阻碍否则不要额外提问）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 阅读本文档和 `docs/platforms/mac/release.md`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 从 `~/.profile` 加载环境变量并确认 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 变量已设置（SPARKLE_PRIVATE_KEY_FILE 应位于 `~/.profile` 中）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 如需要，使用 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 中的 Sparkle 密钥。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **版本和元数据**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 更新 `package.json` 版本（例如 `2026.1.29`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 运行 `pnpm plugins:sync` 以对齐扩展包版本和变更日志。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 更新 CLI/版本字符串：[`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 和 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) 中的 Baileys user agent。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 确认包元数据（name、description、repository、keywords、license）以及 `bin` 映射指向 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) 作为 `openclaw`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 如果依赖项有变化，运行 `pnpm install` 确保 `pnpm-lock.yaml` 是最新的。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **构建和产物**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 如果 A2UI 输入有变化，运行 `pnpm canvas:a2ui:bundle` 并提交更新后的 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm run build`（重新生成 `dist/`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 验证 npm 包的 `files` 包含所有必需的 `dist/*` 文件夹（特别是用于 headless node + ACP CLI 的 `dist/node-host/**` 和 `dist/acp/**`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 确认 `dist/build-info.json` 存在并包含预期的 `commit` 哈希（CLI 横幅在 npm 安装时使用此信息）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 可选：构建后运行 `npm pack --pack-destination /tmp`；检查 tarball 内容并保留以备 GitHub 发布使用（**不要**提交它）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **变更日志和文档**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 更新 `CHANGELOG.md`，添加面向用户的亮点（如果文件不存在则创建）；按版本严格降序排列条目。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 确保 README 示例/标志与当前 CLI 行为匹配（特别是新命令或选项）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **验证**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm test`（如需覆盖率输出则使用 `pnpm test:coverage`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm release:check`（验证 npm pack 内容）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker 安装冒烟测试，快速路径；发布前必需）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 如果已知上一个 npm 发布版本有问题，为预安装步骤设置 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 或 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ]（可选）完整安装程序冒烟测试（添加非 root + CLI 覆盖）：`pnpm test:install:smoke`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ]（可选）安装程序 E2E（Docker，运行 `curl -fsSL https://openclaw.ai/install.sh | bash`，新手引导，然后运行真实工具调用）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e:openai`（需要 `OPENAI_API_KEY`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e:anthropic`（需要 `ANTHROPIC_API_KEY`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e`（需要两个密钥；运行两个提供商）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ]（可选）如果你的更改影响发送/接收路径，抽查 Web Gateway 网关。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **macOS 应用（Sparkle）**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 构建并签名 macOS 应用，然后压缩以供分发。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 生成 Sparkle appcast（通过 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 生成 HTML 注释）并更新 `appcast.xml`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 保留应用 zip（和可选的 dSYM zip）以便附加到 GitHub 发布。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 按照 [macOS 发布](/platforms/mac/release) 获取确切命令和所需环境变量。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `APP_BUILD` 必须是数字且单调递增（不带 `-beta`），以便 Sparkle 正确比较版本。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 如果进行公证，使用从 App Store Connect API 环境变量创建的 `openclaw-notary` 钥匙串配置文件（参见 [macOS 发布](/platforms/mac/release)）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **发布（npm）**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 确认 git 状态干净；根据需要提交并推送。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 如需要，`npm login`（验证 2FA）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `npm publish --access public`（预发布版本使用 `--tag beta`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 验证注册表：`npm view openclaw version`、`npm view openclaw dist-tags` 和 `npx -y openclaw@X.Y.Z --version`（或 `--help`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 故障排除（来自 2.0.0-beta2 发布的笔记）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm pack/publish 挂起或产生巨大 tarball**：`dist/OpenClaw.app` 中的 macOS 应用包（和发布 zip）被扫入包中。通过 `package.json` 的 `files` 白名单发布内容来修复（包含 dist 子目录、docs、skills；排除应用包）。用 `npm pack --dry-run` 确认 `dist/OpenClaw.app` 未列出。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm auth dist-tags 的 Web 循环**：使用旧版认证以获取 OTP 提示：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`npx` 验证失败并显示 `ECOMPROMISED: Lock compromised`**：使用新缓存重试：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **延迟修复后需要重新指向标签**：强制更新并推送标签，然后确保 GitHub 发布资产仍然匹配：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **GitHub 发布 + appcast**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 打标签并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（或 `git push --tags`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 为 `vX.Y.Z` 创建/刷新 GitHub 发布，**标题为 `openclaw X.Y.Z`**（不仅仅是标签）；正文应包含该版本的**完整**变更日志部分（亮点 + 更改 + 修复），内联显示（无裸链接），且**不得在正文中重复标题**。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 附加产物：`npm pack` tarball（可选）、`OpenClaw-X.Y.Z.zip` 和 `OpenClaw-X.Y.Z.dSYM.zip`（如果生成）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 提交更新后的 `appcast.xml` 并推送（Sparkle 从 main 获取源）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 从干净的临时目录（无 `package.json`），运行 `npx -y openclaw@X.Y.Z send --help` 确认安装/CLI 入口点正常工作。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] 宣布/分享发布说明。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 插件发布范围（npm）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
我们只发布 `@openclaw/*` 范围下的**现有 npm 插件**。不在 npm 上的内置插件保持**仅磁盘树**（仍在 `extensions/**` 中发布）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
获取列表的流程：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `npm search @openclaw --json` 并捕获包名。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. 与 `extensions/*/package.json` 名称比较。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. 只发布**交集**（已在 npm 上）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
当前 npm 插件列表（根据需要更新）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/bluebubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/diagnostics-otel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/msteams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/nextcloud-talk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/zalo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
发布说明还必须标注**默认未启用**的**新可选内置插件**（例如：`tlon`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
