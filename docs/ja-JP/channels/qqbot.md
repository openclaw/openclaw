---
summary: "QQ Bot のセットアップ、設定、および使用方法"
read_when:
  - OpenClaw を QQ に接続したい場合
  - QQ Bot の認証情報セットアップが必要な場合
  - QQ Bot のグループまたはプライベートチャットサポートが必要な場合
title: QQ Bot
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: be3b6176a44b28f76c8bb6a8934ee4e20425cbbafdd3ef9c8cae66c9c1d5b7f5
    source_path: channels/qqbot.md
    workflow: 15
---

# QQ Bot

QQ Bot は公式の QQ Bot API（WebSocket ゲートウェイ）を介して OpenClaw に接続します。
プラグインは C2C プライベートチャット、グループ @メッセージ、ギルドチャンネルメッセージにリッチメディア（画像、音声、動画、ファイル）をサポートします。

ステータス: バンドル済みのチャンネルプラグインです。ダイレクトメッセージ、グループチャット、ギルドチャンネル、メディアがサポートされています。リアクションとスレッドはサポートされていません。

## OpenClaw にバンドル済み

現在の OpenClaw インストールには QQ Bot がバンドルされています。通常のセットアップには別途
`openclaw plugins install` ステップは不要です。

## セットアップ

1. [QQ オープンプラットフォーム](https://q.qq.com/)にアクセスして、スマートフォンの QQ で QR コードをスキャンして登録/ログインします。
2. **ボット作成**をクリックして新しい QQ ボットを作成します。
3. ボットの設定ページで **AppID** と **AppSecret** を見つけてコピーします。

> AppSecret は平文では保存されません — ページを離れる前に保存しない場合は新しいものを再生成する必要があります。

4. チャンネルを追加します:

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

5. Gateway ゲートウェイを再起動します。

インタラクティブなセットアップパス:

```bash
openclaw channels add
openclaw configure --section channels
```

## 設定

最小限の設定:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecret: "YOUR_APP_SECRET",
    },
  },
}
```

デフォルトアカウントの環境変数:

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

ファイルバックの AppSecret:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecretFile: "/path/to/qqbot-secret.txt",
    },
  },
}
```

注意:

- 環境変数フォールバックはデフォルトの QQ Bot アカウントのみに適用されます。
- `openclaw channels add --channel qqbot --token-file ...` は AppSecret のみを提供します。AppID は既に設定または `QQBOT_APP_ID` に設定されている必要があります。
- `clientSecret` は平文の文字列だけでなく SecretRef 入力も受け付けます。

### マルチアカウントセットアップ

単一の OpenClaw インスタンスで複数の QQ ボットを実行します:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "111111111",
      clientSecret: "secret-of-bot-1",
      accounts: {
        bot2: {
          enabled: true,
          appId: "222222222",
          clientSecret: "secret-of-bot-2",
        },
      },
    },
  },
}
```

各アカウントは独自の WebSocket 接続を起動し、独立したトークンキャッシュを維持します（`appId` で分離）。

CLI で 2 番目のボットを追加します:

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

### 音声（STT / TTS）

STT と TTS は優先フォールバック付きの 2 レベル設定をサポートします:

| 設定  | プラグイン固有            | フレームワークフォールバック           |
| ----- | -------------------- | ----------------------------- |
| STT   | `channels.qqbot.stt` | `tools.media.audio.models[0]` |
| TTS   | `channels.qqbot.tts` | `messages.tts`                |

```json5
{
  channels: {
    qqbot: {
      stt: {
        provider: "your-provider",
        model: "your-stt-model",
      },
      tts: {
        provider: "your-provider",
        model: "your-tts-model",
        voice: "your-voice",
      },
    },
  },
}
```

無効にするには `enabled: false` を設定します。

アウトバウンドの音声アップロード/トランスコード動作は
`channels.qqbot.audioFormatPolicy` でもチューニングできます:

- `sttDirectFormats`
- `uploadDirectFormats`
- `transcodeEnabled`

## ターゲット形式

| 形式                       | 説明              |
| -------------------------- | ------------------ |
| `qqbot:c2c:OPENID`         | プライベートチャット（C2C） |
| `qqbot:group:GROUP_OPENID` | グループチャット         |
| `qqbot:channel:CHANNEL_ID` | ギルドチャンネル        |

> 各ボットは独自のユーザー OpenID セットを持ちます。ボット A が受け取った OpenID は
> ボット B 経由でメッセージを送信するためには使用**できません**。

## スラッシュコマンド

AI キューの前に傍受される組み込みコマンド:

| コマンド          | 説明                               |
| -------------- | ------------------------------------ |
| `/bot-ping`    | レイテンシテスト                      |
| `/bot-version` | OpenClaw フレームワークバージョンを表示 |
| `/bot-help`    | すべてのコマンドをリスト表示           |
| `/bot-upgrade` | QQBot アップグレードガイドリンクを表示  |
| `/bot-logs`    | 最近の Gateway ゲートウェイログをファイルとしてエクスポート |

使用方法のヘルプを表示するにはコマンドに `?` を付けます（例: `/bot-upgrade ?`）。

## トラブルシューティング

- **ボットが "gone to Mars" と返信する**: 認証情報が設定されていないか、Gateway ゲートウェイが起動していません。
- **インバウンドメッセージがない**: `appId` と `clientSecret` が正しいこと、およびボットが QQ オープンプラットフォームで有効になっていることを確認してください。
- **`--token-file` でのセットアップが未設定と表示される**: `--token-file` は AppSecret のみを設定します。`appId` は設定または `QQBOT_APP_ID` に設定する必要があります。
- **プロアクティブメッセージが届かない**: ユーザーが最近インタラクションしていない場合、QQ がボット起動のメッセージを傍受する可能性があります。
- **音声が文字起こしされない**: STT が設定されており、プロバイダーが到達可能であることを確認してください。
