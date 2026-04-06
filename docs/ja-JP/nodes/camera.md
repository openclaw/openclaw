---
read_when:
    - iOS/AndroidノードまたはmacOSでカメラキャプチャを追加・変更する場合
    - エージェントがアクセス可能なMEDIA一時ファイルワークフローを拡張する場合
summary: カメラキャプチャ（iOS/Androidノード + macOSアプリ）をエージェントで使用：写真（jpg）と短い動画クリップ（mp4）
title: カメラキャプチャ
x-i18n:
    generated_at: "2026-04-02T07:45:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 30b1beaac9602ff29733f72b953065f271928743c8fff03191a007e8b965c88d
    source_path: nodes/camera.md
    workflow: 15
---

# カメラキャプチャ（エージェント）

OpenClawはエージェントワークフロー向けの**カメラキャプチャ**をサポートしている：

- **iOSノード**（Gateway ゲートウェイ経由でペアリング）：`node.invoke`で**写真**（`jpg`）または**短い動画クリップ**（`mp4`、オプションで音声付き）をキャプチャ。
- **Androidノード**（Gateway ゲートウェイ経由でペアリング）：`node.invoke`で**写真**（`jpg`）または**短い動画クリップ**（`mp4`、オプションで音声付き）をキャプチャ。
- **macOSアプリ**（Gateway ゲートウェイ経由のノード）：`node.invoke`で**写真**（`jpg`）または**短い動画クリップ**（`mp4`、オプションで音声付き）をキャプチャ。

すべてのカメラアクセスは**ユーザー制御の設定**によってゲートされている。

## iOSノード

### ユーザー設定（デフォルトはオン）

- iOS設定タブ → **カメラ** → **カメラを許可**（`camera.enabled`）
  - デフォルト：**オン**（キーが存在しない場合は有効として扱われる）。
  - オフの場合：`camera.*`コマンドは`CAMERA_DISABLED`を返す。

### コマンド（Gateway ゲートウェイの`node.invoke`経由）

- `camera.list`
  - レスポンスペイロード：
    - `devices`：`{ id, name, position, deviceType }`の配列

- `camera.snap`
  - パラメータ：
    - `facing`：`front|back`（デフォルト：`front`）
    - `maxWidth`：数値（オプション、iOSノードではデフォルト`1600`）
    - `quality`：`0..1`（オプション、デフォルト`0.9`）
    - `format`：現在は`jpg`
    - `delayMs`：数値（オプション、デフォルト`0`）
    - `deviceId`：文字列（オプション、`camera.list`から取得）
  - レスポンスペイロード：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - ペイロードガード：写真はbase64ペイロードを5 MB以下に抑えるために再圧縮される。

- `camera.clip`
  - パラメータ：
    - `facing`：`front|back`（デフォルト：`front`）
    - `durationMs`：数値（デフォルト`3000`、最大`60000`にクランプ）
    - `includeAudio`：真偽値（デフォルト`true`）
    - `format`：現在は`mp4`
    - `deviceId`：文字列（オプション、`camera.list`から取得）
  - レスポンスペイロード：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### フォアグラウンド要件

`canvas.*`と同様に、iOSノードは**フォアグラウンド**でのみ`camera.*`コマンドを許可する。バックグラウンドでの呼び出しは`NODE_BACKGROUND_UNAVAILABLE`を返す。

### CLIヘルパー（一時ファイル + MEDIA）

添付ファイルを取得する最も簡単な方法はCLIヘルパーを使うことで、デコードされたメディアを一時ファイルに書き込み、`MEDIA:<path>`を出力する。

例：

```bash
openclaw nodes camera snap --node <id>               # デフォルト: front + back の両方（2つのMEDIA行）
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注意：

- `nodes camera snap`はエージェントに両方のビューを提供するため、デフォルトで**両方**の向きをキャプチャする。
- 出力ファイルは一時的（OSの一時ディレクトリ内）であり、独自のラッパーを構築しない限り保持されない。

## Androidノード

### Androidユーザー設定（デフォルトはオン）

- Android設定シート → **カメラ** → **カメラを許可**（`camera.enabled`）
  - デフォルト：**オン**（キーが存在しない場合は有効として扱われる）。
  - オフの場合：`camera.*`コマンドは`CAMERA_DISABLED`を返す。

### パーミッション

- Androidではランタイムパーミッションが必要：
  - `camera.snap`と`camera.clip`の両方に`CAMERA`。
  - `includeAudio=true`の場合、`camera.clip`に`RECORD_AUDIO`。

パーミッションが不足している場合、アプリは可能であればプロンプトを表示する。拒否された場合、`camera.*`リクエストは`*_PERMISSION_REQUIRED`エラーで失敗する。

### Androidフォアグラウンド要件

`canvas.*`と同様に、Androidノードは**フォアグラウンド**でのみ`camera.*`コマンドを許可する。バックグラウンドでの呼び出しは`NODE_BACKGROUND_UNAVAILABLE`を返す。

### Androidコマンド（Gateway ゲートウェイの`node.invoke`経由）

- `camera.list`
  - レスポンスペイロード：
    - `devices`：`{ id, name, position, deviceType }`の配列

### ペイロードガード

写真はbase64ペイロードを5 MB以下に抑えるために再圧縮される。

## macOSアプリ

### ユーザー設定（デフォルトはオフ）

macOSコンパニオンアプリはチェックボックスを提供する：

- **設定 → 一般 → カメラを許可**（`openclaw.cameraEnabled`）
  - デフォルト：**オフ**
  - オフの場合：カメラリクエストは「Camera disabled by user」を返す。

### CLIヘルパー（ノード呼び出し）

macOSノードでカメラコマンドを呼び出すには、メインの`openclaw` CLIを使用する。

例：

```bash
openclaw nodes camera list --node <id>            # カメラIDを一覧表示
openclaw nodes camera snap --node <id>            # MEDIA:<path>を出力
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # MEDIA:<path>を出力
openclaw nodes camera clip --node <id> --duration-ms 3000      # MEDIA:<path>を出力（レガシーフラグ）
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注意：

- `openclaw nodes camera snap`はオーバーライドしない限り、デフォルトで`maxWidth=1600`を使用する。
- macOSでは、`camera.snap`はキャプチャ前にウォームアップ/露出安定後`delayMs`（デフォルト2000ms）待機する。
- 写真ペイロードはbase64を5 MB以下に抑えるために再圧縮される。

## 安全性と実用上の制限

- カメラとマイクへのアクセスは通常のOSパーミッションプロンプトを発生させる（Info.plistに使用方法の文字列が必要）。
- 動画クリップは過大なノードペイロード（base64オーバーヘッド + メッセージ制限）を避けるために上限が設定されている（現在`<= 60秒`）。

## macOS画面録画（OSレベル）

_画面_の動画（カメラではない）には、macOSコンパニオンを使用する：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # MEDIA:<path>を出力
```

注意：

- macOSの**画面収録**パーミッション（TCC）が必要。
