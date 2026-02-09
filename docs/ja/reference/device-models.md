---
summary: "macOS アプリで Apple デバイスのモデル識別子を分かりやすい名称に対応付けるために、OpenClaw がどのようにベンダリングしているかを説明します。"
read_when:
  - デバイスモデル識別子の対応表や NOTICE／ライセンス ファイルを更新する場合
  - Instances UI がデバイス名を表示する方法を変更する場合
title: "デバイスモデル データベース"
---

# デバイスモデル データベース（分かりやすい名称）

macOS のコンパニオンアプリは、Apple のモデル識別子（例: `iPad16,6`、`Mac16,6`）を人が読める名称に対応付けることで、**Instances** UI に分かりやすい Apple デバイスのモデル名を表示します。

この対応表は、次の場所に JSON としてベンダリングされています。

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## データソース

我々は現在、MITライセンスリポジトリからマッピングをベンダーします:

- `kyle-seongwoo-jun/apple-device-identifiers`

ビルドの再現性を保つため、JSON ファイルは特定の上流コミットに固定しています（`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` に記録されています）。

## データベースの更新

1. 固定したい上流コミットを選択します（iOS 用と macOS 用で各 1 つ）。
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` にあるコミットハッシュを更新します。
3. それらのコミットに固定して、JSON ファイルを再ダウンロードします。

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` が引き続き上流と一致していることを確認します（上流のライセンスが変更された場合は置き換えます）。
5. macOS アプリが警告なしで正常にビルドできることを確認します。

```bash
swift build --package-path apps/macos
```
