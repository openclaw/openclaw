---
read_when:
    - デバイスモデル識別子のマッピングまたは NOTICE/ライセンスファイルを更新する場合
    - インスタンス UI でのデバイス名の表示方法を変更する場合
summary: OpenClaw が macOS アプリでフレンドリー名を表示するために Apple デバイスモデル識別子をベンダリングする方法。
title: デバイスモデルデータベース
x-i18n:
    generated_at: "2026-04-02T07:51:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1d99c2538a0d8fdd80fa468fa402f63479ef2522e83745a0a46527a86238aeb2
    source_path: reference/device-models.md
    workflow: 15
---

# デバイスモデルデータベース（フレンドリー名）

macOS コンパニオンアプリは、Apple モデル識別子（例: `iPad16,6`、`Mac16,6`）を人間が読みやすい名前にマッピングすることで、**インスタンス** UI にフレンドリーな Apple デバイスモデル名を表示します。

マッピングは以下のパスに JSON としてベンダリングされています:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## データソース

現在、MIT ライセンスのリポジトリからマッピングをベンダリングしています:

- `kyle-seongwoo-jun/apple-device-identifiers`

ビルドの決定性を保つため、JSON ファイルは特定のアップストリームコミットに固定されています（`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` に記録）。

## データベースの更新

1. 固定したいアップストリームコミットを選択します（iOS 用と macOS 用にそれぞれ1つ）。
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` のコミットハッシュを更新します。
3. それらのコミットに固定して JSON ファイルを再ダウンロードします:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` がアップストリームと一致していることを確認します（アップストリームのライセンスが変更された場合は置き換えてください）。
5. macOS アプリが警告なくクリーンにビルドできることを確認します:

```bash
swift build --package-path apps/macos
```
