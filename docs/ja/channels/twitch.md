---
summary: "Twitch チャットボットの設定とセットアップ"
read_when:
  - OpenClaw 向けに Twitch チャット統合を設定する場合
title: "Twitch"
---

# Twitch（プラグイン）

IRC接続を介したTwitchチャットサポート。 IRC 接続を介した Twitch チャットのサポートです。OpenClaw は Twitch ユーザー（ボットアカウント）として接続し、チャンネル内のメッセージを受信・送信します。

## 必要なプラグイン

Twitch はプラグインとして提供されており、コアインストールには同梱されていません。

CLI（npm レジストリ）からインストールします：

```bash
openclaw plugins install @openclaw/twitch
```

ローカルチェックアウト（git リポジトリから実行する場合）：

```bash
openclaw plugins install ./extensions/twitch
```

詳細： [Plugins](/tools/plugin)

## クイックセットアップ（初心者向け）

1. ボット用の専用 Twitch アカウントを作成します（既存のアカウントでも可）。
2. 認証情報を生成します： [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** を選択します
   - スコープ `chat:read` と `chat:write` が選択されていることを確認します
   - **Client ID** と **Access Token** をコピーします
3. Twitch のユーザー ID を確認します： [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. トークンを設定します：
   - Env： `OPENCLAW_TWITCH_ACCESS_TOKEN=...`（デフォルトアカウントのみ）
   - または config： `channels.twitch.accessToken`
   - 両方が設定されている場合は、config が優先されます（env のフォールバックはデフォルトアカウントのみ）。
5. ゲートウェイを起動します。

**⚠️ 重要：** 不正なユーザーがボットをトリガーするのを防ぐため、アクセス制御（`allowFrom` または `allowedRoles`）を追加してください。 `requireMention` のデフォルトは `true` です。 `requireMention` のデフォルトは `true` です。

最小構成：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## これは何か

- Gateway が所有する Twitch チャンネルです。
- 決定論的ルーティング：返信は常に Twitch に返されます。
- 各アカウントは分離されたセッションキー `agent:<agentId>:twitch:<accountName>` にマッピングされます。
- `username` はボットのアカウント（認証に使用）、`channel` は参加するチャットルームです。

## セットアップ（詳細）

### 認証情報の生成

[Twitch Token Generator](https://twitchtokengenerator.com/) を使用します：

- **Bot Token** を選択します
- スコープ `chat:read` と `chat:write` が選択されていることを確認します
- **Client ID** と **Access Token** をコピーします

手動アプリの登録は必要ありません。 トークンは数時間後に失効します。

### ボットの設定

**環境変数（デフォルトアカウントのみ）：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**または config：**

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

env と config の両方が設定されている場合、config が優先されます。

### アクセス制御（推奨）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

ハード許容リストに `allowFrom` を設定します。 厳格な許可リストには `allowFrom` を推奨します。ロールベースのアクセスにしたい場合は、代わりに `allowedRoles` を使用します。

**利用可能なロール：** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**なぜユーザー ID なのか？** ユーザー名は変更可能で、なりすましが発生する可能性があります。ユーザー ID は恒久的です。 ユーザー ID は永久です。

Twitch のユーザー ID を確認します： [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)（Twitch のユーザー名を ID に変換）

## トークンの更新（任意）

[Twitch Token Generator](https://twitchtokengenerator.com/) のトークンは自動更新できません。期限切れ時に再生成してください。

自動トークン更新を行う場合は、[Twitch Developer Console](https://dev.twitch.tv/console) で独自の Twitch アプリケーションを作成し、config に追加します：

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

ボットは期限前にトークンを自動更新し、更新イベントをログに記録します。

## マルチアカウント対応

アカウントごとのトークンで `channels.twitch.accounts` を使用します。 共有パターンについては [`gateway/configuration`](/gateway/configuration) を参照してください。

例（1 つのボットアカウントを 2 つのチャンネルで使用）：

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

**注記：** 各アカウントには専用のトークンが必要です（チャンネルごとに 1 トークン）。

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

### ユーザー ID による許可リスト（最も安全）

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

`allowFrom` はハード許容リストです。 設定されている場合、それらのユーザー ID のみが許可されます。
`allowFrom` は厳格な許可リストです。設定されている場合、指定されたユーザー ID のみが許可されます。
ロールベースのアクセスを使用する場合は、`allowFrom` を未設定のままにし、代わりに `allowedRoles` を設定してください：

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

### @mention 要件を無効化

デフォルトでは、`requireMention` は `true` です。無効化してすべてのメッセージに応答する場合： すべてのメッセージを無効にして返信するには:

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

まず、診断コマンドを実行します：

```bash
openclaw doctor
openclaw channels status --probe
```

### ボットがメッセージに応答しない

**アクセス制御の確認：** あなたのユーザー ID が `allowFrom` に含まれていることを確認するか、テストのために一時的に
`allowFrom` を削除し、`allowedRoles: ["all"]` を設定してください。

**ボットがチャンネルに参加しているか確認：** ボットは `channel` で指定されたチャンネルに参加している必要があります。

### トークンの問題

**「Failed to connect」または認証エラーの場合：**

- `accessToken` が OAuth アクセストークンの値であることを確認します（通常は `oauth:` プレフィックスで始まります）
- トークンに `chat:read` と `chat:write` のスコープがあることを確認します
- トークン更新を使用している場合、`clientSecret` と `refreshToken` が設定されていることを確認します

### トークン更新が機能しない

**更新イベントのログを確認：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

「token refresh disabled (no refresh token)」と表示される場合：

- `clientSecret` が提供されていることを確認します
- `refreshToken` が提供されていることを確認します

## 設定

**アカウント設定：**

- `username` - ボットのユーザー名
- `accessToken` - `chat:read` と `chat:write` を持つ OAuth アクセストークン
- `clientId` - Twitch Client ID（Token Generator または自分のアプリから取得）
- `channel` - 参加するチャンネル（必須）
- `enabled` - このアカウントを有効化（デフォルト： `true`）
- `clientSecret` - 任意：自動トークン更新用
- `refreshToken` - 任意：自動トークン更新用
- `expiresIn` - トークンの有効期限（秒）
- `obtainmentTimestamp` - トークン取得時刻
- `allowFrom` - ユーザー ID の許可リスト
- `allowedRoles` - ロールベースのアクセス制御（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - @mention を必須にする（デフォルト： `true`）

**プロバイダーオプション：**

- `channels.twitch.enabled` - チャンネル起動の有効／無効
- `channels.twitch.username` - ボットのユーザー名（簡易シングルアカウント設定）
- `channels.twitch.accessToken` - OAuth アクセストークン（簡易シングルアカウント設定）
- `channels.twitch.clientId` - Twitch Client ID（簡易シングルアカウント設定）
- `channels.twitch.channel` - 参加するチャンネル（簡易シングルアカウント設定）
- `channels.twitch.accounts.<accountName>` - マルチアカウント設定（上記すべてのアカウント項目）

完全な例：

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

エージェントは、アクションとして `twitch` を呼び出せます：

- `send` - チャンネルにメッセージを送信

例：

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

- **トークンはパスワードとして扱う** - トークンを git にコミットしないでください
- **長時間稼働するボットには自動トークン更新を使用** してください
- **アクセス制御にはユーザー名ではなくユーザー ID の許可リストを使用** してください
- **トークン更新イベントと接続状態をログで監視** してください
- **トークンのスコープは最小限に** - `chat:read` と `chat:write` のみを要求してください
- **解決しない場合**：他のプロセスがセッションを所有していないことを確認したうえで、ゲートウェイを再起動してください

## 制限

- 1 メッセージあたり **500 文字**（単語境界で自動分割）
- 分割前に Markdown は削除されます
- レート制限なし（Twitch の組み込みレート制限を使用）
