---
summary: "NIP-04 で暗号化されたメッセージによる Nostr の DM チャンネル"
read_when:
  - Nostr 経由で OpenClaw が DM を受信できるようにしたい場合
  - 分散型メッセージングを設定しています
title: "Nostr"
---

# Nostr

**ステータス:** オプションのプラグイン（デフォルトでは無効）。

Nostrはソーシャルネットワーキングのための分散プロトコルです。 Nostr は、ソーシャルネットワーキング向けの分散型プロトコルです。このチャンネルを有効にすると、OpenClaw は NIP-04 を介して暗号化されたダイレクトメッセージ（DM）を受信し、応答できるようになります。

## Install（オンデマンド）

### オンボーディング（推奨）

- オンボーディング ウィザード（`openclaw onboard`）および `openclaw channels add` には、オプションのチャンネル プラグインが一覧表示されます。
- Nostr を選択すると、オンデマンドでプラグインをインストールするよう促されます。

インストールの既定値:

- **Dev チャンネル + git checkout が利用可能:** ローカルのプラグイン パスを使用します。
- **Stable/Beta:** npm からダウンロードします。

プロンプトで、いつでも選択を上書きできます。

### 手動インストール

```bash
openclaw plugins install @openclaw/nostr
```

ローカル checkout を使用（dev ワークフロー）:

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

プラグインをインストールまたは有効にした後、ゲートウェイを再起動します。

## クイックスタート

1. Nostr のキーペアを生成します（必要な場合）:

```bash
# Using nak
nak key generate
```

2. 設定に追加します:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. キーをエクスポートします:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway（ゲートウェイ）を再起動します。

## 設定リファレンス

| キー           | 型                                                            | デフォルト                                       | 説明                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------- |
| `privateKey` | string                                                       | required                                    | `nsec` または hex 形式の秘密鍵 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | リレー URL（WebSocket）    |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM アクセス ポリシー          |
| `allowFrom`  | string[] | `[]`                                        | 許可された送信者の pubkey      |
| `enabled`    | boolean                                                      | `true`                                      | チャンネルの有効／無効           |
| `name`       | string                                                       | -                                           | 表示名                   |
| `profile`    | object                                                       | -                                           | NIP-01 のプロフィール メタデータ  |

## プロフィール メタデータ

プロフィール データは、NIP-01 の `kind:0` イベントとして公開されます。Control UI（Channels -> Nostr -> Profile）から管理するか、設定で直接指定できます。 コントロールUI(Channels -> Nostr -> Profile)から管理することも、configで直接設定することもできます。

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

注記:

- プロフィール URL は `https://` を使用する必要があります。
- リレーからのインポートでは、フィールドをマージし、ローカルの上書き設定は保持されます。

## アクセス制御

### DM ポリシー

- **pairing**（デフォルト）: 未知の送信者にはペアリング コードが送信されます。
- **allowlist**: `allowFrom` に含まれる pubkey のみが DM を送信できます。
- **open**: 公開の受信 DM（`allowFrom: ["*"]` が必要）。
- **disabled**: 受信 DM を無視します。

### Allowlist の例

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

受け入れられる形式:

- **秘密鍵:** `nsec...` または 64 文字の hex
- **Pubkey（`allowFrom`）:** `npub...` または hex

## リレー

デフォルト: `relay.damus.io` および `nos.lol`。

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

- 冗長性のため、2～3 個のリレーを使用してください。
- リレーを増やしすぎないでください（レイテンシや重複の原因になります）。
- 有料リレーは信頼性を向上させる場合があります。
- テスト用途ではローカル リレーでも問題ありません（`ws://localhost:7777`）。

## プロトコル対応

| NIP    | ステータス | 説明                      |
| ------ | ----- | ----------------------- |
| NIP-01 | 対応済み  | 基本イベント形式 + プロフィール メタデータ |
| NIP-04 | 対応済み  | 暗号化 DM（`kind:4`）        |
| NIP-17 | 予定    | ギフトラップ DM               |
| NIP-44 | 予定    | バージョン付き暗号化              |

## テスト

### ローカル リレー

```bash
# Start strfry
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

1. ログからボットの pubkey（npub）を確認します。
2. Nostr クライアント（Damus、Amethyst など）を開きます。
3. ボットの pubkey に DM を送信します。
4. 応答を確認します。

## トラブルシューティング

### メッセージを受信できない場合

- 秘密鍵が有効であることを確認してください。
- リレー URL が到達可能で、`wss://`（ローカルの場合は `ws://`）を使用していることを確認してください。
- `enabled` が `false` ではないことを確認してください。
- Gateway（ゲートウェイ）のログで、リレー接続エラーを確認してください。

### 応答を送信できない場合

- リレーが書き込みを受け付けていることを確認してください。
- 出力接続を確認します。
- リレーのレート制限に注意してください。

### 応答が重複する場合

- 複数のリレーを使用している場合は想定内です。
- メッセージはイベント ID により重複排除され、最初の配信のみが応答をトリガーします。

## セキュリティ

- 秘密鍵を決してコミットしないでください。
- キーには環境変数を使用してください。
- 本番用ボットでは `allowlist` の使用を検討してください。

## 制限事項（MVP）

- ダイレクトメッセージのみ（グループ チャットは非対応）。
- メディア添付は非対応。
- NIP-04 のみ対応（NIP-17 のギフトラップは今後対応予定）。
