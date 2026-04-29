## OpenClaw Android 应用

状态：**极度 alpha 版本**。应用正在从零开始重建。

### 重建清单

- [x] 新的 4 步入门引导流程
- [x] 连接标签页，支持 `Setup Code` + `Manual` 模式
- [x] 网关设置/认证状态的加密持久化
- [x] 聊天 UI 重新设计
- [x] 设置 UI 重新设计并去重（网关控制移至连接）
- [x] 入门引导中的二维码扫描
- [x] 性能改进
- [x] 聊天 UI 流式支持
- [x] 在入门引导/设置流程中请求相机/位置等权限
- [x] 网关/聊天状态更新的推送通知
- [x] 安全加固（生物识别锁、令牌处理、更安全的默认设置）
- [x] 已认证的后台存在信标
- [x] 语音标签完整功能
- [x] 屏幕标签完整功能
- [ ] 完整的端到端 QA 和发布加固

## 在 Android Studio 中打开

- 打开文件夹 `apps/android`。

## 构建/运行

```bash
cd apps/android
./gradlew :app:assemblePlayDebug
./gradlew :app:installPlayDebug
./gradlew :app:testPlayDebugUnitTest
cd ../..
bun run android:bundle:release
```

第三方调试版本：

```bash
cd apps/android
./gradlew :app:assembleThirdPartyDebug
./gradlew :app:installThirdPartyDebug
./gradlew :app:testThirdPartyDebugUnitTest
```

`bun run android:bundle:release` 自动更新 Android `versionName`/`versionCode` 于 `apps/android/app/build.gradle.kts`，然后构建两个签名发布包：

- Play 构建：`apps/android/build/release-bundles/openclaw-<version>-play-release.aab`
- 第三方构建：`apps/android/build/release-bundles/openclaw-<version>-third-party-release.aab`

特定版本的直接 Gradle 任务：

```bash
cd apps/android
./gradlew :app:bundlePlayRelease
./gradlew :app:bundleThirdPartyRelease
```

## Kotlin Lint + 格式化

```bash
pnpm android:lint
pnpm android:format
```

Android framework/resource lint（单独检查）：

```bash
pnpm android:lint:android
```

直接 Gradle 任务：

```bash
cd apps/android
./gradlew :app:ktlintCheck :benchmark:ktlintCheck
./gradlew :app:ktlintFormat :benchmark:ktlintFormat
./gradlew :app:lintDebug
```

`gradlew` 如果 `ANDROID_SDK_ROOT` / `ANDROID_HOME` 未设置，会自动检测 `~/Library/Android/sdk`（macOS 默认）的 Android SDK。

## 宏基准测试（启动+帧时间）

```bash
cd apps/android
./gradlew :benchmark:connectedDebugAndroidTest
```

报告写入位置：

- `apps/android/benchmark/build/reports/androidTests/connected/`

## Perf CLI（低噪声）

确定性启动测量+热点提取，CLI 输出紧凑：

```bash
cd apps/android
./scripts/perf-startup-benchmark.sh
./scripts/perf-startup-hotspots.sh
```

基准脚本行为：

- 仅运行 `StartupMacrobenchmark#coldStartup`（10 次迭代）。
- 一行打印中位数/最小/最大/COV。
- 将带时间戳的快照 JSON 写入 `apps/android/benchmark/results/`。
- 与之前的本地快照自动比较（或者传入显式基准：`--baseline <old-benchmarkData.json>`）。

热点脚本行为：

- 确保已安装调试应用，捕获 `.MainActivity` 的启动 `simpleperf` 数据。
- 打印顶级 DSO、顶级符号和关键应用路径线索（Compose/MainActivity/WebView）。
- 如需更深入的跟进，写入原始 `perf.data` 路径。

## 在真实 Android 手机上运行（USB）

1) 在手机上启用**开发者选项** + **USB 调试**。
2) 通过 USB 连接，并在手机上接受调试信任提示。
3) 验证 ADB 可以看到设备：

```bash
adb devices -l
```

4) 安装+启动调试构建：

```bash
pnpm android:install
pnpm android:run
```

如果 `adb devices -l` 显示 `unauthorized`，重新插拔并再次接受信任提示。

### 仅 USB 网关测试（无 LAN 依赖）

使用 `adb reverse` 使 Android `localhost:18789` 隧道到笔记本 `localhost:18789`。

终端 A（网关）：

```bash
pnpm openclaw gateway --port 18789 --verbose
```

终端 B（USB 隧道）：

```bash
adb reverse tcp:18789 tcp:18789
```

然后在应用**连接 → Manual**中：

- 主机：`127.0.0.1`
- 端口：`18789`
- TLS：关闭

## 热重载/快速迭代

此应用是原生 Kotlin + Jetpack Compose。

- Compose UI 编辑：使用 Android Studio **Live Edit** 调试构建（在物理设备上有效；项目 `minSdk=31` 已满足 API 要求）。
- 许多非结构性代码/资源更改：使用 Android Studio **Apply Changes**。
- 结构性/原生/清单/Gradle 更改：执行完整重装（`pnpm android:run`）。
- Canvas 网页内容从网关 `__openclaw__/canvas/` 加载时已支持热重载（参见 `docs/platforms/android.md`）。

## 连接/配对

1) 启动网关（在主电脑上）：

```bash
pnpm openclaw gateway --port 18789 --verbose
```

2) 在 Android 应用中：

- 打开**连接**标签页。
- 使用**Setup Code**或**Manual**模式连接。

3) 批准配对（在网关电脑上）：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

更多详情：`docs/platforms/android.md`。

## 权限

- 发现：
  - Android 13+（`API 33+`）：`NEARBY_WIFI_DEVICES`
  - Android 12 及以下：`ACCESS_FINE_LOCATION`（NSD 扫描需要）
- 前台服务通知（Android 13+）：`POST_NOTIFICATIONS`
- 相机：
  - `camera.snap` 和 `camera.clip` 需要 `CAMERA`
  - `camera.clip` 当 `includeAudio=true` 时需要 `RECORD_AUDIO`

## Google Play 受限权限

截至 2026 年 3 月 19 日，这些清单权限是此应用主要的 Google Play 策略风险：

- `READ_SMS`
- `SEND_SMS`
- `READ_CALL_LOG`

重要性说明：

- Google Play 将 SMS 和通话记录访问视为高度受限。在大多数情况下，Play 仅允许默认 SMS 应用、默认电话应用、默认助手或狭窄的策略例外。
- 审核通常涉及 `Permissions Declaration Form`、策略理由和 Play Console 中的演示视频证据。
- 如果需要 Play 安全构建，这些应该是首个在特定产品版本/变体后面移除的权限。

当前 OpenClaw Android 影响：

- APK / 侧载构建可以保留 SMS 和通话记录功能。
- Google Play 构建应排除 SMS 发送/搜索和通话记录搜索，除非产品被有意定位并被批准为默认处理程序例外情况。
- 仓库现在将此拆分作为 Android 产品版本：
  - `play`：移除 `READ_SMS`、`SEND_SMS` 和 `READ_CALL_LOG`，并在入门引导、设置和广告节点功能中隐藏 SMS/通话记录界面。
  - `thirdParty`：保留完整权限集和现有 SMS/通话记录功能。

策略链接：

- [Google Play SMS 和通话记录策略](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en)
- [Google Play 敏感权限策略中心](https://support.google.com/googleplay/android-developer/answer/16558241)
- [Android 默认处理程序指南](https://developer.android.com/guide/topics/permissions/default-handlers)

以后添加时需关注的 Play 受限界面：

- `ACCESS_BACKGROUND_LOCATION`
- `MANAGE_EXTERNAL_STORAGE`
- `QUERY_ALL_PACKAGES`
- `REQUEST_INSTALL_PACKAGES`
- `AccessibilityService`

参考链接：

- [后台位置策略](https://support.google.com/googleplay/android-developer/answer/9799150)
- [AccessibilityService 策略](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en-GB)
- [照片和视频权限策略](https://support.google.com/googleplay/android-developer/answer/14594990)

## 集成能力测试（预条件）

此套件假设手动完成设置。它**不**自动安装/运行/配对。

前置检查清单：

1) 网关正在运行且 Android 应用可访问。
2) Android 应用已连接到该网关，`openclaw nodes status` 显示为已配对+已连接。
3) 整个运行期间应用保持解锁且在前台。
4) 打开应用的**屏幕**标签页并在运行期间保持活跃（canvas/A2UI 命令需要在 Canvas WebView 附加在那里）。
5) 为您期望通过的能力授予运行时权限（相机/麦克风/位置/通知监听器/位置等）。
6) 测试开始前不应有待处理的重叠系统对话框。
7) Canvas 主机已启用且设备可访问（不要使用 `OPENCLAW_SKIP_CANVAS_HOST=1` 运行网关；启动日志应包含 `canvas host mounted at .../__openclaw__/`）。
8) 本地操作员测试客户端配对已批准。如果首次运行因 `pairing required` 失败，批准最新的待处理设备配对请求，然后重新运行：
9) 对于 A2UI 检查，保持应用在**屏幕**标签页；节点在首次 A2UI 可达性失败时会自动刷新 canvas 功能（TTL 安全重试）。

```bash
openclaw devices list
openclaw devices approve --latest
```

运行：

```bash
pnpm android:test:integration
```

可选覆盖：

- `OPENCLAW_ANDROID_GATEWAY_URL=ws://...`（默认值：来自您的本地 OpenClaw 配置）
- `OPENCLAW_ANDROID_GATEWAY_TOKEN=...`
- `OPENCLAW_ANDROID_GATEWAY_PASSWORD=...`
- `OPENCLAW_ANDROID_NODE_ID=...` 或 `OPENCLAW_ANDROID_NODE_NAME=...`

功能：

- 从所选 Android 节点读取 `node.describe` 命令列表。
- 调用广告的非交互式命令。
- 此套件中跳过 `screen.record`（Android 需要交互式每次调用的屏幕捕获同意）。
- 断言命令契约（成功或安全无效调用的确定性预期错误，如 `sms.send` 和 `notifications.actions`）。

常见故障快速修复：

- 测试开始前 `pairing required`：
  - 批准待处理设备配对（`openclaw devices approve --latest`）并重新运行。
- `A2UI host not reachable` / `A2UI_HOST_NOT_CONFIGURED`：
  - 确保网关 canvas 主机正在运行且可访问，保持应用在**屏幕**标签页。应用将自动刷新 canvas 功能一次；如果仍然失败，重新连接应用并重新运行。
- `NODE_BACKGROUND_UNAVAILABLE: canvas unavailable`：
  - 应用未有效准备好 canvas 命令；保持应用在前台且**屏幕**标签页活跃。

## 贡献

此 Android 应用正在重建中。
维护者：@obviyus。对于问题/问题/贡献，请提交 issue 或在 Discord 上联系。
