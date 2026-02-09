---
summary: "エージェント利用向けのカメラキャプチャ（iOS ノード + macOS アプリ）：写真（jpg）と短い動画クリップ（mp4）"
read_when:
  - iOS ノードまたは macOS におけるカメラキャプチャの追加や変更を行う場合
  - エージェントがアクセス可能な MEDIA 一時ファイルのワークフローを拡張する場合
title: "カメラキャプチャ"
---

# カメラキャプチャ（エージェント）

OpenClaw は、エージェントのワークフロー向けに **カメラキャプチャ** をサポートします。

- **iOS ノード**（Gateway（ゲートウェイ）経由でペアリング）：`node.invoke` により **写真**（`jpg`）または **短い動画クリップ**（`mp4`、任意で音声付き）をキャプチャします。
- **Android ノード**（Gateway（ゲートウェイ）経由でペアリング）：`node.invoke` により **写真**（`jpg`）または **短い動画クリップ**（`mp4`、任意で音声付き）をキャプチャします。
- **macOS アプリ**（Gateway（ゲートウェイ）経由のノード）：`node.invoke` により **写真**（`jpg`）または **短い動画クリップ**（`mp4`、任意で音声付き）をキャプチャします。

すべてのカメラアクセスは **ユーザーが制御する設定** によって制限されます。

## iOS ノード

### ユーザー設定（既定でオン）

- iOS 設定タブ → **Camera** → **Allow Camera**（`camera.enabled`）
  - 既定値：**オン**（キーが存在しない場合は有効として扱われます）。
  - オフの場合：`camera.*` コマンドは `CAMERA_DISABLED` を返します。

### コマンド（Gateway `node.invoke` 経由）

- `camera.list`
  - レスポンスペイロード：
    - `devices`：`{ id, name, position, deviceType }` の配列

- `camera.snap`
  - Params:
    - `facing`：`front|back`（既定値：`front`）
    - `maxWidth`：number（任意；iOS ノードでは既定 `1600`）
    - `quality`：`0..1`（任意；既定 `0.9`）
    - `format`：現在は `jpg`
    - `delayMs`：number（任意；既定 `0`）
    - `deviceId`：string（任意；`camera.list` から）
  - レスポンスペイロード：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - ペイロードガード：写真は、base64 ペイロードが 5 MB 未満になるよう再圧縮されます。

- `camera.clip`
  - Params:
    - `facing`：`front|back`（既定値：`front`）
    - `durationMs`：number（既定 `3000`、最大 `60000` にクランプ）
    - `includeAudio`：boolean（既定 `true`）
    - `format`：現在は `mp4`
    - `deviceId`：string（任意；`camera.list` から）
  - レスポンスペイロード：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### フォアグラウンド要件

`canvas.*` と同様に、iOS ノードは **フォアグラウンド** でのみ `camera.*` コマンドを許可します。バックグラウンドからの呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。 バックグラウンドでの呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。

### CLI ヘルパー（一時ファイル + MEDIA）

添付ファイルを取得する最も簡単な方法は CLI ヘルパーを使用することです。これはデコードされたメディアを一時ファイルに書き込み、`MEDIA:<path>` を出力します。

例：

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注記：

- `nodes camera snap` は、エージェントに両方の視点を提供するため、既定で **両方** の向きになります。
- 出力ファイルは、独自のラッパーを構築しない限り、一時的（OS の一時ディレクトリ内）です。

## Android ノード

### Android ユーザー設定（既定でオン）

- Android 設定シート → **Camera** → **Allow Camera**（`camera.enabled`）
  - 既定値：**オン**（キーが存在しない場合は有効として扱われます）。
  - オフの場合：`camera.*` コマンドは `CAMERA_DISABLED` を返します。

### 権限

- Android では実行時権限が必要です。
  - `CAMERA`：`camera.snap` と `camera.clip` の両方に必要です。
  - `RECORD_AUDIO`：`includeAudio=true` の場合に `camera.clip` に必要です。

権限が不足している場合、可能であればアプリがプロンプトを表示します。拒否された場合、`camera.*` リクエストは `*_PERMISSION_REQUIRED` エラーで失敗します。

### Android のフォアグラウンド要件

`canvas.*` と同様に、Android ノードは **フォアグラウンド** でのみ `camera.*` コマンドを許可します。バックグラウンドからの呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。 バックグラウンドでの呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します。

### ペイロードガード

写真は、base64 ペイロードが 5 MB 未満になるよう再圧縮されます。

## macOS アプリ

### ユーザー設定（既定でオフ）

macOS コンパニオンアプリはチェックボックスを提供します。

- **Settings → General → Allow Camera**（`openclaw.cameraEnabled`）
  - 既定値：**オフ**
  - オフの場合：カメラ要求は「Camera disabled by user」を返します。

### CLI ヘルパー（ノード呼び出し）

メインの `openclaw` CLI を使用して、macOS ノード上のカメラコマンドを呼び出します。

例：

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注記：

- `openclaw nodes camera snap` は、上書きされない限り既定で `maxWidth=1600` です。
- macOS では、`camera.snap` はウォームアップ／露出の安定後に `delayMs`（既定 2000 ms）待機してからキャプチャします。
- 写真のペイロードは、base64 が 5 MB 未満になるよう再圧縮されます。

## 安全性 + 実用上の制限

- カメラおよびマイクへのアクセスは、通常の OS 権限プロンプトをトリガーします（Info.plist に使用目的の文字列が必要です）。
- 動画クリップは、ノードのペイロードが過大にならないよう（base64 のオーバーヘッド + メッセージ制限）、上限（現在は `<= 60s`）が設定されています。

## macOS 画面動画（OS レベル）

カメラではなく _画面_ 動画については、macOS コンパニオンを使用してください。

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

注記：

- macOS の **Screen Recording** 権限（TCC）が必要です。
