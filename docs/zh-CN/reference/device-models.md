---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 更新设备型号标识符映射或 NOTICE/许可证文件（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 更改实例 UI 中设备名称的显示方式（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: OpenClaw 如何内置 Apple 设备型号标识符以在 macOS 应用中显示友好名称。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: 设备型号数据库（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-01T21:37:07Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 1d99c2538a0d8fdd80fa468fa402f63479ef2522e83745a0a46527a86238aeb2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: reference/device-models.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 设备型号数据库（友好名称）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS 配套应用通过将 Apple 型号标识符（例如 `iPad16,6`、`Mac16,6`）映射为人类可读的名称，在**实例** UI 中显示友好的 Apple 设备型号名称。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
该映射以 JSON 形式内置于：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 数据来源（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
我们目前内置的映射来自 MIT 许可的仓库：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kyle-seongwoo-jun/apple-device-identifiers`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
为保持构建的确定性，JSON 文件固定到特定的上游提交（记录在 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 中）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 更新数据库（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. 选择要固定的上游提交（iOS 和 macOS 各一个）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. 更新 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 中的提交哈希。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. 重新下载固定到这些提交的 JSON 文件：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. 确保 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` 仍与上游一致（如果上游许可证发生变更，请替换该文件）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. 验证 macOS 应用能够正常构建（无警告）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift build --package-path apps/macos（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
