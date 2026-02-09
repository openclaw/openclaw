---
summary: "OpenClaw の presence エントリーがどのように生成、マージ、表示されるか"
read_when:
  - Instances タブのデバッグ時
  - 重複または古いインスタンス行を調査する場合
  - ゲートウェイの WS 接続や system-event ビーコンを変更する場合
title: "Presence"
---

# Presence

OpenClaw の「presence」は、次の対象についての軽量でベストエフォートな可視化です。

- **Gateway** 自体
- **Gateway に接続しているクライアント**（mac アプリ、WebChat、CLI など）

Presence は主に macOS アプリの **Instances** タブを描画し、オペレーターに素早い可視性を提供するために使用されます。

## Presence フィールド（表示される内容）

Presence エントリーは、次のようなフィールドを持つ構造化オブジェクトです。

- `instanceId`（任意ですが強く推奨）: 安定したクライアント識別子（通常は `connect.client.instanceId`）
- `host`: 人が読みやすいホスト名
- `ip`: ベストエフォートの IP アドレス
- `version`: クライアントのバージョン文字列
- `deviceFamily` / `modelIdentifier`: ハードウェアのヒント
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: 「最後のユーザー入力からの経過秒数」（既知の場合）
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: 最終更新タイムスタンプ（エポックからのミリ秒）

## Producers（presence の生成元）

Presence エントリーは複数のソースから生成され、**マージ**されます。

### 1. Gateway 自身のエントリー

Gateway は起動時に常に「self」エントリーをシードします。これにより、クライアントがまだ接続していない場合でも、UI にゲートウェイ ホストが表示されます。

### 2. WebSocket 接続

すべての WS クライアントは `connect` リクエストから開始します。ハンドシェイクが成功すると、Gateway はその接続に対する presence エントリーを upsert します。 ハンドシェイクに成功すると、
Gatewayはその接続のプレゼンスエントリをアップサートします。

#### なぜ単発の CLI コマンドは表示されないのか

CLIは多くの場合、短いワンオフコマンドを接続します。 CLI は短時間で単発のコマンド実行のために接続されることがよくあります。Instances リストへのスパムを避けるため、`client.mode === "cli"` は presence エントリーに**変換されません**。

### 3. `system-event` ビーコン

クライアントは、 `system-event` メソッドを使用して、より豊かな定期的なビーコンを送信できます。 Mac
アプリはホスト名、IP、および `lastInputSeconds` をレポートするためにこれを使用します。

### 4. ノード接続（role: node）

ノードが `role: node` を用いて Gateway WebSocket 経由で接続すると、Gateway はそのノードに対する presence エントリーを upsert します（他の WS クライアントと同じフローです）。

## マージと重複排除のルール（なぜ `instanceId` が重要か）

Presence エントリーは、単一のインメモリ マップに保存されます。

- エントリーは **presence key** によってキー付けされます。
- 最適なキーは、再起動をまたいでも維持される安定した `instanceId`（`connect.client.instanceId` から取得）です。
- キーは大文字小文字を区別しません。

クライアントが安定した `instanceId` なしで再接続すると、**重複**行として表示される場合があります。

## TTL とサイズ制限

Presenceは意図的に一時的なものです:

- **TTL:** 5 分以上前のエントリーは削除されます
- **最大エントリー数:** 200（最も古いものから削除）

これにより、リストを新鮮に保ち、メモリ使用量の無制限な増加を防ぎます。

## リモート／トンネル時の注意点（ループバック IP）

SSH トンネルやローカル ポートフォワード経由でクライアントが接続する場合、Gateway からはリモート アドレスが `127.0.0.1` として見えることがあります。適切なクライアント報告 IP を上書きしないよう、ループバックのリモート アドレスは無視されます。 良好なクライアント報告済みの
IP を上書きしないように、ループバックのリモートアドレスは無視されます。

## Consumers

### macOS の Instances タブ

macOS アプリは `system-presence` の出力を描画し、最終更新の経過時間に基づいて小さなステータス インジケーター（Active / Idle / Stale）を適用します。

## デバッグのヒント

- 生のリストを確認するには、Gateway に対して `system-presence` を呼び出します。
- 重複が見られる場合:
  - ハンドシェイクでクライアントが安定した `client.instanceId` を送信していることを確認します
  - 定期ビーコンが同じ `instanceId` を使用していることを確認します
  - 接続由来のエントリーに `instanceId` が欠けていないか確認します（この場合、重複は想定どおりです）
