---
summary: "エージェント使用のカメラキャプチャ（iOS ノード + macOS アプリ）: 写真（jpg）と短いビデオクリップ（mp4）"
read_when:
  - iOS ノードまたは macOS でのカメラキャプチャの追加または変更
  - エージェントがアクセスできる MEDIA 一時ファイルワークフローの拡張
title: "カメラキャプチャ"
---

# カメラキャプチャ（エージェント）

OpenClaw はエージェントワークフロー用の**カメラキャプチャ**をサポートしています:

- **iOS ノード**（Gateway 経由でペアリング）: `node.invoke` を通じて**写真**（`jpg`）または**短いビデオクリップ**（`mp4`、オプションの音声付き）をキャプチャします。
- **Android ノード**（Gateway 経由でペアリング）: `node.invoke` を通じて**写真**（`jpg`）または**短いビデオクリップ**（`mp4`、オプションの音声付き）をキャプチャします。
- **macOS アプリ**（Gateway 経由のノード）: `node.invoke` を通じて**写真**（`jpg`）または**短いビデオクリップ**（`mp4`、オプションの音声付き）をキャプチャします。

すべてのカメラアクセスは**ユーザーが制御する設定**の背後にあります。

## iOS ノード

### ユーザー設定（デフォルト: オン）

- iOS の「設定」タブ → **カメラ** → **カメラを許可する**（`camera.enabled`）
  - デフォルト: **オン**（キーが存在しない場合は有効として扱われます）。
  - オフの場合: `camera.*` コマンドは `CAMERA_DISABLED` を返します。

### コマンド（Gateway `node.invoke` 経由）

- `camera.list`
  - レスポンスペイロード:
    - `devices`: `{ id, name, position, deviceType }` の配列

- `camera.snap`
  - パラメータ:
    - `facing`: `front|back`（デフォルト: `front`）
    - `maxWidth`: 数値（オプション; iOS ノードのデフォルト `1600`）
    - `quality`: `0..1`（オプション; デフォルト `0.9`）
    - `format`: 現在は `jpg`
    - `delayMs`: 数値（オプション; デフォルト `0`）
    - `deviceId`: 文字列（オプション; `camera.list` から）
  - レスポンスペイロード:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - ペイロードガード: base64 ペイロードが 5MB 以下になるように写真を再圧縮します。

- `camera.clip`
  - パラメータ:
    - `facing`: `front|back`（デフォルト: `front`）
    - `durationMs`: 数値（デフォルト `3000`、最大 `60000` にクランプ）
    - `includeAudio`: ブーリアン（デフォルト `true`）
    - `format`: 現在は `mp4`
    - `deviceId`: 文字列（オプション; `camera.list` から）
  - レスポンスペイロード:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### フォアグラウンド要件

`canvas.*` と同様に、iOS ノードは `camera.*` コマンドを**フォアグラウンド**でのみ許可します。バックグラウンド呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。

### CLI ヘルパー（一時ファイル + MEDIA）

添付ファイルを取得する最も簡単な方法は CLI ヘルパーを使用することです。デコードされたメディアを一時ファイルに書き込み、`MEDIA:<path>` を出力します。

例:

```bash
openclaw nodes camera snap --node <id>               # デフォルト: 前面 + 背面の両方（2 つの MEDIA 行）
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注意:

- `nodes camera snap` はデフォルトで**両方の**向きで撮影してエージェントに両方のビューを提供します。
- 出力ファイルは一時的（OS の一時ディレクトリ）です。独自のラッパーを作成しない限り。

## Android ノード

### Android ユーザー設定（デフォルト: オン）

- Android の「設定」シート → **カメラ** → **カメラを許可する**（`camera.enabled`）
  - デフォルト: **オン**（キーが存在しない場合は有効として扱われます）。
  - オフの場合: `camera.*` コマンドは `CAMERA_DISABLED` を返します。

### パーミッション

- Android はランタイムパーミッションが必要です:
  - `camera.snap` と `camera.clip` の両方に `CAMERA`。
  - `includeAudio=true` の `camera.clip` に `RECORD_AUDIO`。

パーミッションが欠落している場合、アプリは可能であればプロンプトを表示します。拒否された場合、`camera.*` リクエストは `*_PERMISSION_REQUIRED` エラーで失敗します。

### Android フォアグラウンド要件

`canvas.*` と同様に、Android ノードは `camera.*` コマンドを**フォアグラウンド**でのみ許可します。バックグラウンド呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。

### Android コマンド（Gateway `node.invoke` 経由）

- `camera.list`
  - レスポンスペイロード:
    - `devices`: `{ id, name, position, deviceType }` の配列

### ペイロードガード

base64 ペイロードが 5MB 以下になるように写真を再圧縮します。

## macOS アプリ

### ユーザー設定（デフォルト: オフ）

macOS コンパニオンアプリはチェックボックスを提供しています:

- **設定 → 一般 → カメラを許可する**（`openclaw.cameraEnabled`）
  - デフォルト: **オフ**
  - オフの場合: カメラリクエストは「カメラはユーザーによって無効化されています」を返します。

### CLI ヘルパー（ノード呼び出し）

メインの `openclaw` CLI を使用して macOS ノードでカメラコマンドを呼び出します。

例:

```bash
openclaw nodes camera list --node <id>            # カメラ ID を一覧表示
openclaw nodes camera snap --node <id>            # MEDIA:<path> を出力
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # MEDIA:<path> を出力
openclaw nodes camera clip --node <id> --duration-ms 3000      # MEDIA:<path> を出力（レガシーフラグ）
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注意:

- `openclaw nodes camera snap` はオーバーライドされない限り `maxWidth=1600` がデフォルトです。
- macOS では、`camera.snap` はキャプチャ前にウォームアップ/露出の安定化のために `delayMs`（デフォルト 2000ms）待機します。
- base64 が 5MB 以下になるように写真ペイロードを再圧縮します。

## 安全性と実際の制限

- カメラとマイクへのアクセスは通常の OS パーミッションプロンプトをトリガーします（Info.plist の使用文字列が必要です）。
- ビデオクリップは（現在 `<= 60秒`）にキャップされており、過大なノードペイロード（base64 オーバーヘッド + メッセージ制限）を避けます。

## macOS スクリーンビデオ（OS レベル）

_スクリーン_ビデオ（カメラではない）には、macOS コンパニオンを使用します:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # MEDIA:<path> を出力
```

注意:

- macOS の**画面収録**パーミッション（TCC）が必要です。
