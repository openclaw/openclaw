---
read_when:
    - OpenClawのTwitchチャット連携を設定する
summary: Twitchチャットボットの設定とセットアップ
title: Twitch
x-i18n:
    generated_at: "2026-04-02T07:32:31Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 50a74894dee8f22652de06b1bff32e4acafa7ab98a4c777988d78de61fdcc115
    source_path: channels/twitch.md
    workflow: 15
---

# Twitch（プラグイン）

IRC接続によるTwitchチャットサポート。OpenClawはTwitchユーザー（ボットアカウント）として接続し、チャネルでメッセージを受信・送信します。

## プラグインが必要です

Twitchはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）：

```bash
openclaw plugins install @openclaw/twitch
```

ローカルチェックアウト（gitリポジトリから実行する場合）：

```bash
openclaw plugins install ./path/to/local/twitch-plugin
```

詳細：[プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. ボット用の専用Twitchアカウントを作成します（既存のアカウントを使用することも可能です）。
2. 認証情報を生成します：[Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** を選択
   - スコープ `chat:read` と `chat:write` が選択されていることを確認
   - **Client ID** と **Access Token** をコピー
3. TwitchユーザーIDを確認します：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. トークンを設定します：
   - 環境変数：`OPENCLAW_TWITCH_ACCESS_TOKEN=...`（デフォルトアカウントのみ）
   - または設定：`channels.twitch.accessToken`
   - 両方設定されている場合、設定が優先されます（環境変数のフォールバックはデフォルトアカウントのみ）。
5. Gateway ゲートウェイを起動します。

**⚠️ 重要：** 未認可のユーザーがボットをトリガーするのを防ぐため、アクセス制御（`allowFrom` または `allowedRoles`）を追加してください。`requireMention` はデフォルトで `true` です。

最小設定：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // ボットのTwitchアカウント
      accessToken: "oauth:abc123...", // OAuthアクセストークン（またはOPENCLAW_TWITCH_ACCESS_TOKEN環境変数を使用）
      clientId: "xyz789...", // Token GeneratorのClient ID
      channel: "vevisk", // 参加するTwitchチャネルのチャット（必須）
      allowFrom: ["123456789"], // （推奨）あなたのTwitchユーザーIDのみ - https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/ で取得
    },
  },
}
```

## 概要

- Gateway ゲートウェイが所有するTwitchチャネル。
- 決定的ルーティング：返信は常にTwitchに戻ります。
- 各アカウントは分離されたセッションキー `agent:<agentId>:twitch:<accountName>` にマッピングされます。
- `username` はボットのアカウント（認証に使用）、`channel` は参加するチャットルームです。

## セットアップ（詳細）

### 認証情報の生成

[Twitch Token Generator](https://twitchtokengenerator.com/) を使用します：

- **Bot Token** を選択
- スコープ `chat:read` と `chat:write` が選択されていることを確認
- **Client ID** と **Access Token** をコピー

手動でのアプリ登録は不要です。トークンは数時間後に期限切れになります。

### ボットの設定

**環境変数（デフォルトアカウントのみ）：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**または設定：**

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

環境変数と設定の両方が設定されている場合、設定が優先されます。

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

ハードな許可リストには `allowFrom` を推奨します。ロールベースのアクセスが必要な場合は、代わりに `allowedRoles` を使用してください。

**利用可能なロール：** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**なぜユーザーIDなのか？** ユーザー名は変更可能であり、なりすましが可能です。ユーザーIDは永続的です。

TwitchユーザーIDの確認：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)（Twitchユーザー名をIDに変換）

## トークンリフレッシュ（オプション）

[Twitch Token Generator](https://twitchtokengenerator.com/) からのトークンは自動リフレッシュできません。期限切れの場合は再生成してください。

自動トークンリフレッシュを行うには、[Twitch Developer Console](https://dev.twitch.tv/console) で独自のTwitchアプリケーションを作成し、設定に追加します：

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

アカウントごとのトークンで `channels.twitch.accounts` を使用します。共通パターンについては [`gateway/configuration`](/gateway/configuration) を参照してください。

例（1つのボットアカウントを2つのチャネルで使用）：

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

**注意：** 各アカウントには独自のトークンが必要です（チャネルごとに1つのトークン）。

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

`allowFrom` はハードな許可リストです。設定すると、そのユーザーIDのみが許可されます。
ロールベースのアクセスが必要な場合は、`allowFrom` を未設定のまま `allowedRoles` を設定してください：

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

デフォルトでは `requireMention` は `true` です。すべてのメッセージに応答するには無効化します：

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

**アクセス制御を確認：** あなたのユーザーIDが `allowFrom` に含まれていることを確認するか、テスト用に一時的に `allowFrom` を削除して `allowedRoles: ["all"]` を設定してください。

**ボットがチャネルに参加しているか確認：** ボットは `channel` で指定されたチャネルに参加する必要があります。

### トークンの問題

**「Failed to connect」または認証エラー：**

- `accessToken` がOAuthアクセストークンの値であることを確認してください（通常は `oauth:` プレフィックスで始まります）
- トークンに `chat:read` と `chat:write` スコープがあることを確認してください
- トークンリフレッシュを使用している場合、`clientSecret` と `refreshToken` が設定されていることを確認してください

### トークンリフレッシュが動作しない

**リフレッシュイベントのログを確認：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

「token refresh disabled (no refresh token)」と表示される場合：

- `clientSecret` が設定されていることを確認してください
- `refreshToken` が設定されていることを確認してください

## 設定

**アカウント設定：**

- `username` - ボットのユーザー名
- `accessToken` - `chat:read` と `chat:write` を持つOAuthアクセストークン
- `clientId` - Twitch Client ID（Token Generatorまたは独自アプリから取得）
- `channel` - 参加するチャネル（必須）
- `enabled` - このアカウントを有効にする（デフォルト：`true`）
- `clientSecret` - オプション：自動トークンリフレッシュ用
- `refreshToken` - オプション：自動トークンリフレッシュ用
- `expiresIn` - トークン有効期限（秒）
- `obtainmentTimestamp` - トークン取得時のタイムスタンプ
- `allowFrom` - ユーザーID許可リスト
- `allowedRoles` - ロールベースのアクセス制御（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - @メンション必須（デフォルト：`true`）

**プロバイダーオプション：**

- `channels.twitch.enabled` - チャネル起動の有効化/無効化
- `channels.twitch.username` - ボットのユーザー名（簡易シングルアカウント設定）
- `channels.twitch.accessToken` - OAuthアクセストークン（簡易シングルアカウント設定）
- `channels.twitch.clientId` - Twitch Client ID（簡易シングルアカウント設定）
- `channels.twitch.channel` - 参加するチャネル（簡易シングルアカウント設定）
- `channels.twitch.accounts.<accountName>` - マルチアカウント設定（上記すべてのアカウントフィールド）

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

エージェントは以下のアクションで `twitch` を呼び出せます：

- `send` - チャネルにメッセージを送信

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

- **トークンはパスワードと同様に扱ってください** - トークンをgitにコミットしないでください
- **長時間稼働するボットには自動トークンリフレッシュを使用してください**
- **アクセス制御にはユーザー名ではなくユーザーID許可リストを使用してください**
- **ログを監視して** トークンリフレッシュイベントと接続状態を確認してください
- **トークンのスコープは最小限に** - `chat:read` と `chat:write` のみをリクエストしてください
- **問題が発生した場合**：他のプロセスがセッションを所有していないことを確認してから、Gateway ゲートウェイを再起動してください

## 制限事項

- メッセージあたり **500文字**（単語境界で自動分割）
- Markdownは分割前に除去されます
- レート制限なし（Twitchの組み込みレート制限を使用）

## 関連

- [チャネル概要](/channels) — サポートされているすべてのチャネル
- [ペアリング](/channels/pairing) — ダイレクトメッセージの認証とペアリングフロー
- [グループ](/channels/groups) — グループチャットの動作とメンションゲーティング
- [チャネルルーティング](/channels/channel-routing) — メッセージのセッションルーティング
- [セキュリティ](/gateway/security) — アクセスモデルとハードニング
