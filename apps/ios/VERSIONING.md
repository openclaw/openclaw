# OpenClaw iOS 版本管理

OpenClaw iOS 使用**固定 CalVer 发布版本**，而不是在每次构建时自动读取当前网关版本。

## 目标

- 在迭代时保持 TestFlight 提交在一个稳定的应用版本上
- 在正常 TestFlight 迭代期间仅更改 `CFBundleVersion`
- 仅在维护者选择时才将 iOS 发布版本提升到当前网关版本
- 保持 Apple bundle 字段对 App Store Connect 有效
- 从 iOS 专有变更日志生成 App Store 发布说明

## 版本模型

固定的 iOS 发布版本位于 `apps/ios/version.json`。

支持的固定格式：

- `YYYY.M.D`

示例：

- `2026.4.6`
- `2026.4.10`

根网关版本在 `package.json` 中可能是：

- `YYYY.M.D`
- `YYYY.M.D-beta.N`
- `YYYY.M.D-N`

当您从网关版本固定 iOS 时，iOS 工具会剥离网关后缀，仅保留基本 CalVer。

示例：

- 网关 `2026.4.10` -> iOS `2026.4.10`
- 网关 `2026.4.10-beta.3` -> iOS `2026.4.10`
- 网关 `2026.4.10-2` -> iOS `2026.4.10`

## Apple bundle 映射

固定 iOS 版本 `2026.4.10` 映射到：

- `CFBundleShortVersionString = 2026.4.10`
- `CFBundleVersion = 仅数字构建号`

`CFBundleShortVersionString` 在您有意固定更新的 iOS 发布版本之前保持固定在 TestFlight 序列上。

## 真相来源和生成文件

### 源文件

- `apps/ios/version.json`
  - 固定的 iOS 发布版本
- `apps/ios/CHANGELOG.md`
  - iOS 专用变更日志和发布说明源
- `apps/ios/VERSIONING.md`
  - 工作流程和约束

### 生成或派生文件

- `apps/ios/Config/Version.xcconfig`
  - 从 `apps/ios/version.json` 派生的签入默认值
- `apps/ios/fastlane/metadata/en-US/release_notes.txt`
  - 从 `apps/ios/CHANGELOG.md` 生成
- `apps/ios/build/Version.xcconfig`
  - 每次构建或 beta 准备时生成的本地 gitignored 构建覆盖

## 工具界面

### 版本解析和同步工具

- `scripts/lib/ios-version.ts`
  - 验证固定的 iOS CalVer
  - 规范化网关版本 -> 固定的 iOS CalVer
  - 渲染签入的 xcconfig 和发布说明
- `scripts/ios-version.ts`
  - JSON、shell 或单字段版本读取的 CLI
- `scripts/ios-sync-versioning.ts`
  - 从固定的 iOS 版本同步签入的派生文件
- `scripts/ios-pin-version.ts`
  - 显式地将 iOS 固定到选定的发布版本或当前网关版本

### 构建和 beta 流程

- `scripts/ios-write-version-xcconfig.sh`
  - 读取固定的 iOS 版本
  - 在 `apps/ios/build/Version.xcconfig` 中写入本地数字构建覆盖文件
- `scripts/ios-beta-prepare.sh`
  - 根据固定的 iOS 版本准备 beta 签名和 bundle 设置
- `apps/ios/fastlane/Fastfile`
  - 从固定的 iOS 版本辅助工具解析版本元数据
  - 为固定的短版本递增 TestFlight 构建号

## 发布说明解析顺序

生成 `apps/ios/fastlane/metadata/en-US/release_notes.txt` 时，工具按此顺序读取第一个可用的变更日志部分：

1. 精确固定版本，例如 `## 2026.4.10`
2. `## Unreleased`

推荐工作流程：

- 在 TestFlight 序列上迭代时，在 `## Unreleased` 下保留待处理说明
- 在生产发布之前，将最终说明移动或复制到 `## <固定版本>` 下并再次运行同步

## 常用命令

```bash
pnpm ios:version
pnpm ios:version:check
pnpm ios:version:sync
pnpm ios:version:pin -- --from-gateway
pnpm ios:version:pin -- --version 2026.4.10
```

## 正常 TestFlight 迭代工作流程

1. 保持 `apps/ios/version.json` 固定到当前 TestFlight 序列版本
2. 在 `## Unreleased` 下更新 `apps/ios/CHANGELOG.md` 进行迭代
3. 使用常用流程上传更多 beta
4. 让 Fastlane 仅递增 `CFBundleVersion`

这在审核进行期间保持 TestFlight 版本稳定。

## 新发布提升工作流程

当您希望下一个生产 iOS 发布与当前网关发布对齐时：

1. 从根网关版本固定 iOS：

```bash
pnpm ios:version:pin -- --from-gateway
```

2. 审查生成的变化：
   - `apps/ios/version.json`
   - `apps/ios/Config/Version.xcconfig`
   - `apps/ios/fastlane/metadata/en-US/release_notes.txt`
3. 根据需要为新发布更新 `apps/ios/CHANGELOG.md`
4. 如果变更日志更改，再次运行 `pnpm ios:version:sync`
5. 提交该新固定版本的第一个 TestFlight 构建
6. 仅通过构建号迭代，直到发布候选版本准备好
7. 发布该审核过的 TestFlight 构建到生产

## 重要不变式

Fastlane 和 Xcode 应该仅从 `apps/ios/version.json` 消耗固定的 iOS 版本。

仅更改 `package.json.version` 必须不能更改 iOS 应用版本，除非维护者明确运行固定步骤。
