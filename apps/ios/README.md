# OpenClaw iOS（超级 Alpha）

此 iPhone 应用是超级 alpha 版本，仅供内部使用。它作为 `role: node` 连接到 OpenClaw Gateway。

## 分发状态

- 公开分发：不可用。
- 内部 beta 分发：本地归档 + 通过 Fastlane 上传 TestFlight。
- 通过 Xcode 的本地/手动部署仍然是默认开发路径。

## 超级 Alpha 免责声明

- 预计会有破坏性更改。
- UI 和入门引导流程可能会在没有迁移保证的情况下更改。
- 前台使用是目前唯一可靠的模式。
- 在权限和后台行为仍在加固时，将此构建视为敏感版本。

## 精确的 Xcode 手动部署流程

1. 前置条件：
   - Xcode 16+
   - `pnpm`
   - `xcodegen`
   - 在 Xcode 中设置 Apple Development 签名
2. 从仓库根目录：

```bash
pnpm install
./scripts/ios-configure-signing.sh
cd apps/ios
xcodegen generate
open OpenClaw.xcodeproj
```

3. 在 Xcode 中：
   - Scheme：`OpenClaw`
   - 目标：已连接的 iPhone（推荐用于真实行为）
   - 构建配置：`Debug`
   - 运行（`Product` -> `Run`）
4. 如果个人团队签名失败：
   - 通过 `apps/ios/LocalSigning.xcconfig` 使用唯一的本地 bundle ID。
   - 从 `apps/ios/LocalSigning.xcconfig.example` 开始。

快捷命令（相同流程 + 打开项目）：

```bash
pnpm ios:open
```

## 本地 Beta 发布流程

前置条件：

- Xcode 16+
- `pnpm`
- `xcodegen`
- `fastlane`
- Xcode 中登录的 Apple 账户用于自动签名/配置
- 当自动解析 beta 构建号或上传到 TestFlight 时，通过 `scripts/ios-asc-keychain-setup.sh` 在 Keychain 中设置 App Store Connect API 密钥

发布行为：

- 本地开发继续使用 `scripts/ios-configure-signing.sh` 中的唯一每开发者 bundle ID。
- Beta 发布通过 `apps/ios/build/BetaRelease.xcconfig` 中的临时生成 xcconfig 使用规范的 `ai.openclaw.client*` bundle ID。
- Beta 发布还将应用切换到 `OpenClawPushTransport=relay`、`OpenClawPushDistribution=official` 和 `OpenClawPushAPNsEnvironment=production`。
- Beta 流程不修改 `apps/ios/.local-signing.xcconfig` 或 `apps/ios/LocalSigning.xcconfig`。
- `apps/ios/version.json` 是固定的 iOS 发布版本源。
- `apps/ios/CHANGELOG.md` 是 iOS 专用变更日志和发布说明源。
- 固定的 iOS 版本必须使用 CalVer，如 `2026.4.10`。
- 该固定值变为：
  - `CFBundleShortVersionString = 2026.4.10`
  - `CFBundleVersion = 该 2026.4.10 的下一个 TestFlight 构建号`
- 更改根网关版本不会更改 iOS 应用版本，直到您明确从网关固定。
- 完整工作流程参见 `apps/ios/VERSIONING.md`。

Beta 构建所需的环境：

- `OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com`
  这必须是纯 `https://host[:port][/path]` 基础 URL，不含空白、查询参数、片段或 xcconfig 特殊字符。

归档不上传：

```bash
pnpm ios:beta:archive
```

归档并上传到 TestFlight：

```bash
pnpm ios:beta
```

如果您需要强制使用特定构建号：

```bash
pnpm ios:beta -- --build-number 7
```

### 维护者快速发布检查清单

当克隆缺少本地 iOS 发布设置且您想要最短路径到 TestFlight 上传时使用。

1. 确认 Fastlane 认证已设置：

```bash
cd apps/ios
fastlane ios auth_check
```

2. 如果认证缺失，在此 Mac 上一次性引导：

```bash
scripts/ios-asc-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

这应该创建包含非密钥 ASC 变量的 `apps/ios/fastlane/.env`，而私钥保留在 Keychain 中。

3. 为构建设置官方/TestFlight 中继 URL：

```bash
export OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com
```

4. 如果您正在启动全新的生产发布序列，先将 iOS 固定到当前网关版本：

```bash
pnpm ios:version:pin -- --from-gateway
```

5. 上传 beta：

```bash
pnpm ios:beta
```

6. 预期行为：
   - Fastlane 读取 `apps/ios/version.json`
   - 验证同步的 iOS 版本工件
   - 解析该短版本的下一个 TestFlight 构建号
   - 生成 `apps/ios/build/BetaRelease.xcconfig`
   - 归档 `OpenClaw`
   - 将 IPA 上传到 TestFlight

7. 成功运行后的预期输出：
   - `apps/ios/build/beta/OpenClaw-<version>.ipa`
   - `apps/ios/build/beta/OpenClaw-<version>.app.dSYM.zip`
   - Fastlane 日志行如 `Uploaded iOS beta: version=<version> short=<short> build=<build>`

8. 如果这是同一 Mac 上已正常工作过的维护者机器上的全新克隆，可以从同一 Mac 上的另一个可信本地克隆复制非密钥的 `apps/ios/fastlane/.env`。Keychain 备份私钥是机器本地的，不存储在仓库中。

## iOS 版本管理工作流程

- 固定的 iOS 发布版本：`apps/ios/version.json`
- iOS 专用变更日志：`apps/ios/CHANGELOG.md`
- 生成的签入工件：
  - `apps/ios/Config/Version.xcconfig`
  - `apps/ios/fastlane/metadata/en-US/release_notes.txt`
- 有用的命令：

```bash
pnpm ios:version
pnpm ios:version:check
pnpm ios:version:sync
pnpm ios:version:pin -- --from-gateway
pnpm ios:version:pin -- --version 2026.4.10
```

推荐流程：

### 在现有序列上 TestFlight 迭代

1. 保持 `apps/ios/version.json` 固定到当前序列版本。
2. 在 `## Unreleased` 下更新 `apps/ios/CHANGELOG.md` 进行迭代。
3. 变更日志更改后运行 `pnpm ios:version:sync`。
4. 使用 `pnpm ios:beta` 上传更多 TestFlight 构建。
5. 让 Fastlane 仅增加数字构建号。

### 启动下一个生产发布序列

1. 将 iOS 固定到当前网关版本：

```bash
pnpm ios:version:pin -- --from-gateway
```

2. 根据需要更新新发布的 `apps/ios/CHANGELOG.md`。
3. 运行 `pnpm ios:version:sync`。
4. 提交该新固定版本的第一个 TestFlight 构建。
5. 在同一版本上继续迭代，直到发布候选版本准备好。

详细规格参见 `apps/ios/VERSIONING.md`。

## 本地/手动构建的 APNs 期望

- 应用在启动时调用 `registerForRemoteNotifications()`。
- `apps/ios/Sources/OpenClaw.entitlements` 将 `aps-environment` 设置为 `development`。
- APNs 令牌注册到网关仅在网关连接后发生（`push.apns.register`）。
- 本地/手动构建默认为 `OpenClawPushTransport=direct` 和 `OpenClawPushDistribution=local`。
- 您选择的团队/配置文件必须支持您正在签名的应用 bundle ID 的推送通知。
- 如果推送能力或配置错误，APNs 注册将在运行时失败（检查 Xcode 日志中的 `APNs registration failed`）。
- 网关主机还需要使用 `OPENCLAW_APNS_TEAM_ID`、`OPENCLAW_APNS_KEY_ID` 以及 `OPENCLAW_APNS_PRIVATE_KEY_P8` 或 `OPENCLAW_APNS_PRIVATE_KEY_PATH` 单独配置直接 APNs 认证。
- 推荐网关主机存储 APNs `.p8` 文件的位置是 `~/.openclaw/credentials/apns/AuthKey_<KEYID>.p8`，并设置限制性权限，然后将 `OPENCLAW_APNS_PRIVATE_KEY_PATH` 指向该文件。
- `apps/ios/fastlane/.env` 仅涵盖 App Store Connect / Fastlane 认证；它不提供用于本地直接推送测试的网关 APNs 凭证。
- Debug 构建默认为 `OpenClawPushAPNsEnvironment=sandbox`；Release 构建默认为 `production`。

## 官方构建的 APNs 期望

- 官方/TestFlight 构建在将 `push.apns.register` 发布到网关之前先向外部推送中继注册。
- 网关的中继模式注册包含不透明的中继句柄、注册作用域的发送授权、中继源元数据和安装元数据，而不是原始 APNs 令牌。
- 中继注册绑定到从 `gateway.identity.get` 获取的网关身份，因此另一个网关不能重用该存储的注册。
- 应用在本地持久化中继句柄元数据，以便重新连接可以重新发布网关注册，而无需每次连接时重新注册。
- 如果后续构建中中继基础 URL 更改，应用会刷新中继注册而不是重用旧的中继源。
- 中继模式需要可访问的中继基础 URL，并在注册期间使用 App Attest 加上 StoreKit 应用事务 JWS。
- 网关侧中继发送通过 `openclaw.json` 中的 `gateway.push.apns.relay.baseUrl` 配置。`OPENCLAW_APNS_RELAY_BASE_URL` 仍然是临时环境覆盖。

## 官方构建中继信任模型

- `iOS -> 网关`
  - 应用必须与网关配对并建立节点和操作员会话。
  - 操作员会话用于获取 `gateway.identity.get`。
- `iOS -> 中继`
  - 应用使用 App Attest 加上 StoreKit 应用事务 JWS 通过 HTTPS 向中继注册。
  - 中继需要官方生产/TestFlight 分发路径，这就是本地 Xcode/dev 安装不能使用托管中继的原因。
- `网关委托`
  - 应用在中继注册中包含网关身份。
  - 中继返回委托给该网关的中继句柄和注册作用域的发送授权。
- `网关 -> 中继`
  - 网关使用自己的设备身份签署中继发送请求。
  - 中继在发送到 APNs 之前验证委托的发送授权和网关签名。
- `中继 -> APNs`
  - 生产 APNs 凭证和原始官方构建 APNs 令牌保留在中继部署中，而不是网关上。

此模型将托管中继限制为真正的 OpenClaw 官方构建，并确保网关只能向与该网关配对的 iOS 设备发送推送。

## 目前可用的功能（具体）

- 通过设置代码流程配对（`/pair` 然后 `/pair approve` 在 Telegram 中）。
- 通过发现或手动主机/端口以及 TLS 指纹信任提示进行网关连接。
- 通过操作员网关会话的聊天+通话界面。
- 前台中的 iPhone 节点命令：相机 snap/clip、canvas present/navigate/eval/snapshot、屏幕录制、位置、联系人、日历、提醒事项、照片、运动、本地通知。
- Share 扩展深度链接转发到已连接网关会话。

## 与计算机使用的关系

iOS 应用不是 Codex 计算机使用后端。计算机使用和 `cua-driver mcp` 是 macOS 桌面控制路径；iOS 通过网关将设备功能公开为 OpenClaw 节点命令。代理可以使用 `node.invoke` 驱动 iPhone canvas、相机、屏幕、位置、语音和其他节点功能，受 iOS 前台/后台限制。

## 位置自动化用例（测试）

将此用于自动化信号（"我移动了"、"我到达了"、"我离开了"），而不是作为保持唤醒机制。

- 产品意图：
  - 由 iOS 位置事件驱动的移动感知自动化
  - 示例：到达/离开地理围栏、重大移动、访问检测
- 非目标：
  - 连续 GPS 轮询只是为了保持应用存活

包含在 QA 运行中的测试路径：

1. 在应用中启用位置权限：
   - 设置 `始终` 权限
   - 验证构建配置文件中已启用后台位置能力
2. 后台应用并触发移动：
   - 步行/驾驶足够距离以获取重大位置更新，或跨越配置的地理围栏
3. 验证网关副作用：
   - 如需要则节点重新连接/唤醒
   - 预期位置/移动事件到达网关
   - 自动化触发器执行一次（无重复风暴）
4. 验证资源影响：
   - 无持续高热状态
   - 在短观察窗口内无过多后台电池消耗

通过标准：

- 移动事件足够可靠地传递以实现自动化 UX
- 无位置驱动的重新连接垃圾邮件循环
- 应用在反复后台/前台转换后保持稳定

## 已知问题/限制/问题

- 前台优先：iOS 可以在后台挂起套接字；重新连接恢复仍在调优中。
- 后台命令限制严格：`canvas.*`、`camera.*`、`screen.*` 和 `talk.*` 在后台时被阻止。
- 后台位置需要 `始终` 位置权限。
- 配对/认证错误有意暂停重新连接循环，直到人工修复认证/配对状态。
- 语音唤醒和通话争夺同一麦克风；通话在活跃时抑制唤醒捕获。
- APNs 可靠性取决于本地签名/配置/主题对齐。
- 在活跃开发期间预计会有粗糙的 UX 边缘和偶尔的重新连接波动。

## 当前进行中的工作流

自动唤醒/重新连接加固：

- 跨场景转换改善唤醒/恢复行为
- 减少后台 -> 前台后的死套接字状态
- 收紧节点/操作员会话重新连接协调
- 减少瞬态网络故障后的手动恢复步骤

## 调试检查清单

1. 确认构建/签名基线：
   - 重新生成项目（`xcodegen generate`）
   - 验证选定的团队 + bundle ID
2. 在应用 `设置 -> 网关` 中：
   - 确认状态文本、服务器和远程地址
   - 验证状态是否显示配对/认证阻塞
3. 如果需要配对：
   - 从 Telegram 运行 `/pair approve`，然后重新连接
4. 如果发现不稳定：
   - 启用 `发现调试日志`
   - 检查 `设置 -> 网关 -> 发现日志`
5. 如果网络路径不清楚：
   - 在网关高级设置中切换到手动主机/端口 + TLS
6. 在 Xcode 控制台中，按子系统/类别过滤信号：
   - `ai.openclaw.ios`
   - `GatewayDiag`
   - `APNs registration failed`
7. 验证后台期望：
   - 首先在前台重现
   - 然后测试后台转换并确认返回时重新连接
