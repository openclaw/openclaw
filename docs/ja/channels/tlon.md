---
summary: "Tlon / Urbit のサポート状況、機能、および設定"
read_when:
  - Tlon / Urbit チャンネル機能の作業時
title: "Tlon"
---

# Tlon（プラグイン）

TlonはUrbit上に構築された分散型メッセンジャーです。 Tlon は Urbit 上に構築された分散型メッセンジャーです。OpenClaw はあなたの Urbit ship に接続し、ダイレクトメッセージやグループチャットのメッセージに応答できます。グループでの返信は、デフォルトでは @ メンションが必要で、さらに許可リストによって制限できます。 グループの返信にはデフォルトで@メンションが必要で、
許容リストを介してさらに制限することができます。

ステータス: プラグイン経由でサポートされています。 DM、グループメンション、スレッドの返信、およびテキストのみメディアのフォールバック
(キャプションに追加されたURL)。 リアクション、アンケート、およびネイティブメディアのアップロードはサポートされていません。

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

自動検索はデフォルトで有効になっています。 手動でチャンネルをピン留めすることもできます。

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
