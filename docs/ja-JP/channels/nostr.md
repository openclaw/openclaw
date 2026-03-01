---
summary: "NIP-04暗号化メッセージによるNostr DMチャンネル"
read_when:
  - OpenClawでNostr経由のDMを受信したいとき
  - 分散型メッセージングを設定するとき
title: "Nostr"
---

# Nostr

**ステータス:** オプションプラグイン（デフォルトで無効）。

Nostrはソーシャルネットワーキングのための分散型プロトコルです。このチャンネルにより、OpenClawはNIP-04を介した暗号化ダイレクトメッセージ（DM）を受信・応答できます。

## インストール（オンデマンド）

### オンボーディング（推奨）

- オンボーディングウィザード（`openclaw onboard`）および`openclaw channels add`では、オプションのチャンネルプラグインが一覧表示されます。
- Nostrを選択すると、プラグインのオンデマンドインストールが求められます。

インストールのデフォルト:

- **Devチャンネル + gitチェックアウトが利用可能:** ローカルプラグインパスを使用します。
- **Stable/Beta:** npmからダウンロードします。

プロンプトで選択をいつでもオーバーライドできます。

### 手動インストール

```bash
openclaw plugins install @openclaw/nostr
```

ローカルチェックアウトを使用（開発ワークフロー）:

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

プラグインのインストールまたは有効化後にGatewayを再起動してください。

## クイックセットアップ

1. Nostrキーペアを生成します（必要な場合）:

```bash
# nakを使用
nak key generate
```

2. 設定に追加:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. キーをエクスポート:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gatewayを再起動します。

## 設定リファレンス

| キー          | 型       | デフォルト                                     | 説明                         |
| ------------ | -------- | ------------------------------------------- | ----------------------------------- |
| `privateKey` | string   | 必須                                    | `nsec`または16進数形式の秘密鍵 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | リレーURL（WebSocket）              |
| `dmPolicy`   | string   | `pairing`                                   | DMアクセスポリシー                    |
| `allowFrom`  | string[] | `[]`                                        | 許可された送信者の公開鍵              |
| `enabled`    | boolean  | `true`                                      | チャンネルの有効/無効              |
| `name`       | string   | -                                           | 表示名                        |
| `profile`    | object   | -                                           | NIP-01プロフィールメタデータ             |

## プロフィールメタデータ

プロフィールデータはNIP-01の`kind:0`イベントとして公開されます。コントロールUI（チャンネル -> Nostr -> プロフィール）から管理するか、設定で直接設定できます。

例:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

注意事項:

- プロフィールURLは`https://`を使用する必要があります。
- リレーからのインポートはフィールドをマージし、ローカルのオーバーライドを保持します。

## アクセス制御

### DMポリシー

- **pairing**（デフォルト）: 未知の送信者にはペアリングコードが提示されます。
- **allowlist**: `allowFrom`に含まれる公開鍵のみがDMを送信できます。
- **open**: パブリック受信DM（`allowFrom: ["*"]`が必要）。
- **disabled**: 受信DMを無視します。

### 許可リストの例

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## キー形式

対応形式:

- **秘密鍵:** `nsec...`または64文字の16進数
- **公開鍵（`allowFrom`）:** `npub...`または16進数

## リレー

デフォルト: `relay.damus.io`と`nos.lol`。

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

ヒント:

- 冗長性のために2-3のリレーを使用してください。
- リレーを多くしすぎないでください（レイテンシ、重複）。
- 有料リレーは信頼性を向上させる場合があります。
- テスト用にはローカルリレーで問題ありません（`ws://localhost:7777`）。

## プロトコルサポート

| NIP    | ステータス    | 説明                           |
| ------ | --------- | ------------------------------------- |
| NIP-01 | サポート済み | 基本イベント形式 + プロフィールメタデータ |
| NIP-04 | サポート済み | 暗号化DM（`kind:4`）              |
| NIP-17 | 計画中   | ギフトラップDM                      |
| NIP-44 | 計画中   | バージョン管理された暗号化                  |

## テスト

### ローカルリレー

```bash
# strfryを起動
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### 手動テスト

1. ログからボットの公開鍵（npub）を確認します。
2. Nostrクライアント（Damus、Amethystなど）を開きます。
3. ボットの公開鍵にDMを送信します。
4. 応答を確認します。

## トラブルシューティング

### メッセージが受信されない

- 秘密鍵が有効であることを確認してください。
- リレーURLに到達可能で、`wss://`（またはローカルの場合は`ws://`）を使用していることを確認してください。
- `enabled`が`false`でないことを確認してください。
- Gatewayログでリレー接続エラーを確認してください。

### 応答が送信されない

- リレーが書き込みを受け入れることを確認してください。
- 送信接続を確認してください。
- リレーのレート制限に注意してください。

### 重複応答

- 複数のリレーを使用する場合に想定される動作です。
- メッセージはイベントIDで重複排除されます。最初の配信のみが応答をトリガーします。

## セキュリティ

- 秘密鍵をコミットしないでください。
- キーには環境変数を使用してください。
- 本番ボットには`allowlist`の使用を検討してください。

## 制限事項（MVP）

- ダイレクトメッセージのみ（グループチャットなし）。
- メディア添付ファイルなし。
- NIP-04のみ（NIP-17ギフトラップは計画中）。
