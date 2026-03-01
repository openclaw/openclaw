---
summary: "Twitchチャットボットの設定とセットアップ"
read_when:
  - OpenClawのTwitchチャット統合を設定するとき
title: "Twitch"
---

# Twitch（プラグイン）

IRC接続経由のTwitchチャットサポートです。OpenClawはTwitchユーザー（ボットアカウント）として接続し、チャンネルでメッセージを受信・送信します。

## プラグインが必要です

Twitchはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/twitch
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/twitch
```

詳細: [プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. ボット用の専用Twitchアカウントを作成します（または既存のアカウントを使用）。
2. 認証情報を生成: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token**を選択
   - `chat:read`と`chat:write`のスコープが選択されていることを確認
   - **Client ID**と**Access Token**をコピー
3. TwitchユーザーIDを調べる: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. トークンを設定:
   - 環境変数: `OPENCLAW_TWITCH_ACCESS_TOKEN=...`（デフォルトアカウントのみ）
   - または設定: `channels.twitch.accessToken`
   - 両方設定されている場合、設定が優先されます（環境変数のフォールバックはデフォルトアカウントのみ）。
5. Gatewayを起動します。

**注意:** 許可されていないユーザーがボットをトリガーするのを防ぐため、アクセス制御（`allowFrom`または`allowedRoles`）を追加してください。`requireMention`はデフォルトで`true`です。

最小設定:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // ボットのTwitchアカウント
      accessToken: "oauth:abc123...", // OAuthアクセストークン（またはOPENCLAW_TWITCH_ACCESS_TOKEN環境変数を使用）
      clientId: "xyz789...", // Token GeneratorからのClient ID
      channel: "vevisk", // 参加するTwitchチャンネルのチャット（必須）
      allowFrom: ["123456789"], // （推奨）あなたのTwitchユーザーIDのみ
    },
  },
}
```

## 概要

- Gatewayが管理するTwitchチャンネルです。
- 決定論的ルーティング: 返信は常にTwitchに戻ります。
- 各アカウントは分離されたセッションキー`agent:<agentId>:twitch:<accountName>`にマッピングされます。
- `username`はボットのアカウント（認証する者）、`channel`は参加するチャットルームです。

## セットアップ（詳細）

### 認証情報の生成

[Twitch Token Generator](https://twitchtokengenerator.com/)を使用:

- **Bot Token**を選択
- `chat:read`と`chat:write`のスコープが選択されていることを確認
- **Client ID**と**Access Token**をコピー

手動のアプリ登録は不要です。トークンは数時間後に期限切れになります。

### ボットの設定

**環境変数（デフォルトアカウントのみ）:**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**または設定:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

環境変数と設定の両方がある場合、設定が優先されます。

### アクセス制御（推奨）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // （推奨）あなたのTwitchユーザーIDのみ
    },
  },
}
```

ハード許可リストには`allowFrom`を使用してください。ロールベースのアクセスが必要な場合は代わりに`allowedRoles`を使用します。

**利用可能なロール:** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**なぜユーザーIDか？** ユーザー名は変更可能で、なりすましが可能です。ユーザーIDは永続的です。

TwitchユーザーIDを調べる: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)

## トークンリフレッシュ（オプション）

[Twitch Token Generator](https://twitchtokengenerator.com/)からのトークンは自動リフレッシュできません。期限切れ時に再生成してください。

自動トークンリフレッシュには、[Twitch Developer Console](https://dev.twitch.tv/console)で独自のTwitchアプリケーションを作成し、設定に追加します:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

ボットは期限切れ前にトークンを自動的にリフレッシュし、リフレッシュイベントをログに記録します。

## マルチアカウントサポート

アカウントごとのトークンを使用して`channels.twitch.accounts`を設定します。共通パターンについては[`gateway/configuration`](/gateway/configuration)を参照してください。

例（1つのボットアカウントで2つのチャンネル）:

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**注意:** 各アカウントには独自のトークンが必要です（チャンネルごとに1トークン）。

## アクセス制御

### ロールベースの制限

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### ユーザーIDによる許可リスト（最も安全）

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### ロールベースのアクセス（代替）

`allowFrom`はハード許可リストです。設定すると、それらのユーザーIDのみが許可されます。
ロールベースのアクセスが必要な場合は、`allowFrom`を未設定のままにし、代わりに`allowedRoles`を設定してください:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @メンション要件の無効化

デフォルトでは`requireMention`は`true`です。無効にしてすべてのメッセージに応答するには:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## トラブルシューティング

まず診断コマンドを実行してください:

```bash
openclaw doctor
openclaw channels status --probe
```

### ボットがメッセージに応答しない

**アクセス制御を確認:** あなたのユーザーIDが`allowFrom`に含まれていることを確認するか、テスト用に一時的に`allowFrom`を削除して`allowedRoles: ["all"]`を設定してください。

**ボットがチャンネルにいるか確認:** ボットは`channel`で指定されたチャンネルに参加する必要があります。

### トークンの問題

**「接続失敗」または認証エラー:**

- `accessToken`がOAuthアクセストークンの値であることを確認（通常`oauth:`プレフィックスで始まる）
- トークンに`chat:read`と`chat:write`のスコープがあることを確認
- トークンリフレッシュを使用している場合、`clientSecret`と`refreshToken`が設定されていることを確認

### トークンリフレッシュが機能しない

**リフレッシュイベントのログを確認:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

「token refresh disabled (no refresh token)」と表示される場合:

- `clientSecret`が提供されていることを確認
- `refreshToken`が提供されていることを確認

## 設定

**アカウント設定:**

- `username` - ボットのユーザー名
- `accessToken` - `chat:read`と`chat:write`を含むOAuthアクセストークン
- `clientId` - TwitchのClient ID（Token Generatorまたはあなたのアプリから）
- `channel` - 参加するチャンネル（必須）
- `enabled` - このアカウントの有効化（デフォルト: `true`）
- `clientSecret` - オプション: 自動トークンリフレッシュ用
- `refreshToken` - オプション: 自動トークンリフレッシュ用
- `expiresIn` - トークン有効期限（秒）
- `obtainmentTimestamp` - トークン取得タイムスタンプ
- `allowFrom` - ユーザーID許可リスト
- `allowedRoles` - ロールベースのアクセス制御（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - @メンション必須（デフォルト: `true`）

**プロバイダーオプション:**

- `channels.twitch.enabled` - チャンネル起動の有効/無効
- `channels.twitch.username` - ボットのユーザー名（簡易シングルアカウント設定）
- `channels.twitch.accessToken` - OAuthアクセストークン（簡易シングルアカウント設定）
- `channels.twitch.clientId` - TwitchのClient ID（簡易シングルアカウント設定）
- `channels.twitch.channel` - 参加するチャンネル（簡易シングルアカウント設定）
- `channels.twitch.accounts.<accountName>` - マルチアカウント設定（上記のすべてのアカウントフィールド）

完全な例:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## ツールアクション

エージェントは`twitch`を以下のアクションで呼び出せます:

- `send` - チャンネルにメッセージを送信

例:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## 安全性と運用

- **トークンはパスワードと同様に扱ってください** - gitにトークンをコミットしないでください
- **長時間実行ボットには自動トークンリフレッシュを使用してください**
- **アクセス制御にはユーザー名ではなくユーザーID許可リストを使用してください**
- **ログを監視して**トークンリフレッシュイベントと接続状態を確認してください
- **トークンのスコープは最小限に** - `chat:read`と`chat:write`のみをリクエストしてください
- **問題が解決しない場合**: 他のプロセスがセッションを所有していないことを確認してからGatewayを再起動してください

## 制限事項

- メッセージあたり**500文字**（単語境界で自動分割）
- 分割前にMarkdownは除去されます
- レート制限なし（Twitchの組み込みレート制限を使用）
