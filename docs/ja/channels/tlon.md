---
summary: 「Tlon / Urbit のサポート状況、機能、および設定」
read_when:
  - Tlon / Urbit チャンネル機能の作業時
title: 「Tlon」
x-i18n:
  source_path: channels/tlon.md
  source_hash: 85fd29cda05b4563
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:20:51Z
---

# Tlon（プラグイン）

Tlon は Urbit 上に構築された分散型メッセンジャーです。OpenClaw はあなたの Urbit ship に接続し、ダイレクトメッセージやグループチャットのメッセージに応答できます。グループでの返信は、デフォルトでは @ メンションが必要で、さらに許可リストによって制限できます。

ステータス: プラグイン経由でサポートされています。ダイレクトメッセージ、グループメンション、スレッド返信、テキストのみのメディアフォールバック（キャプションに URL を付加）が利用可能です。リアクション、投票、ネイティブメディアアップロードはサポートされていません。

## プラグインが必要

Tlon はプラグインとして提供されており、コアインストールには含まれていません。

CLI（npm レジストリ）からインストール:

```bash
openclaw plugins install @openclaw/tlon
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/tlon
```

詳細: [Plugins](/tools/plugin)

## セットアップ

1. Tlon プラグインをインストールします。
2. ship URL とログインコードを用意します。
3. `channels.tlon` を設定します。
4. ゲートウェイを再起動します。
5. ボットにダイレクトメッセージを送信するか、グループチャンネルでメンションします。

最小構成（単一アカウント）:

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## グループチャンネル

自動検出はデフォルトで有効です。チャンネルを手動でピン留めすることもできます。

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

自動検出を無効化:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## アクセス制御

ダイレクトメッセージの許可リスト（空 = すべて許可）:

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

グループ認可（デフォルトでは制限されています）:

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## 配信ターゲット（CLI / cron）

`openclaw message send` または cron 配信と組み合わせて使用します。

- ダイレクトメッセージ: `~sampel-palnet` または `dm/~sampel-palnet`
- グループ: `chat/~host-ship/channel` または `group:~host-ship/channel`

## 注記

- グループでの返信にはメンション（例: `~your-bot-ship`）が必要です。
- スレッド返信: 受信メッセージがスレッド内の場合、OpenClaw はスレッド内で返信します。
- メディア: `sendMedia` はテキスト + URL にフォールバックします（ネイティブアップロードはありません）。
