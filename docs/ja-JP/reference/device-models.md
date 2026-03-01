---
summary: "OpenClaw が macOS アプリのインスタンス UI でフレンドリー名を表示するために Apple デバイスモデル識別子を管理する方法。"
read_when:
  - デバイスモデル識別子のマッピングや NOTICE/ライセンスファイルを更新するとき
  - インスタンス UI のデバイス名表示の変更を行うとき
title: "デバイスモデルデータベース"
---

# デバイスモデルデータベース（フレンドリー名）

macOS コンパニオンアプリは、Apple モデル識別子（例: `iPad16,6`、`Mac16,6`）を人間が読める名前にマッピングすることで、**インスタンス** UI にフレンドリーな Apple デバイスモデル名を表示します。

マッピングは次の場所に JSON としてベンダー管理されています:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## データソース

現在、MIT ライセンスのリポジトリからマッピングをベンダー管理しています:

- `kyle-seongwoo-jun/apple-device-identifiers`

ビルドを確定的に保つため、JSON ファイルは特定のアップストリームコミットに固定されています（`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` に記録）。

## データベースの更新

1. 固定したいアップストリームコミットを選択します（iOS 用と macOS 用の 2 つ）。
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` のコミットハッシュを更新します。
3. それらのコミットに固定して JSON ファイルを再ダウンロードします:

```bash
IOS_COMMIT="<ios-device-identifiers.json のコミット sha>"
MAC_COMMIT="<mac-device-identifiers.json のコミット sha>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` がアップストリームと一致していることを確認します（アップストリームのライセンスが変更された場合は置き換えてください）。
5. macOS アプリがクリーンにビルドされることを確認します（警告なし）:

```bash
swift build --package-path apps/macos
```
