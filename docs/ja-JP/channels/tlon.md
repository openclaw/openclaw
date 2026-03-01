---
summary: "Tlon/Urbitのサポート状況、機能、設定"
read_when:
  - Tlon/Urbitチャンネル機能を作業するとき
title: "Tlon"
---

# Tlon（プラグイン）

TlonはUrbit上に構築された分散型メッセンジャーです。OpenClawはあなたのUrbitシップに接続し、
DMやグループチャットメッセージに応答できます。グループ返信はデフォルトで@メンションが必要で、
許可リストによってさらに制限できます。

ステータス: プラグインでサポート。DM、グループメンション、スレッド返信、テキストのみのメディアフォールバック
（URLがキャプションに追加される）。リアクション、投票、ネイティブメディアアップロードはサポートされていません。

## プラグインが必要です

Tlonはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/tlon
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/tlon
```

詳細: [プラグイン](/tools/plugin)

## セットアップ

1. Tlonプラグインをインストールします。
2. シップのURLとログインコードを用意します。
3. `channels.tlon`を設定します。
4. Gatewayを再起動します。
5. ボットにDMを送信するか、グループチャンネルでメンションします。

最小設定（シングルアカウント）:

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

プライベート/LANシップURL（上級者向け）:

デフォルトでは、OpenClawはこのプラグインのプライベート/内部ホスト名およびIP範囲をブロックします（SSRF対策）。
シップURLがプライベートネットワーク上にある場合（例: `http://192.168.1.50:8080`や`http://localhost:8080`）、
明示的にオプトインする必要があります:

```json5
{
  channels: {
    tlon: {
      allowPrivateNetwork: true,
    },
  },
}
```

## グループチャンネル

自動検出はデフォルトで有効です。手動でチャンネルを固定することもできます:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

自動検出を無効にする:

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

DM許可リスト（空 = すべて許可）:

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

グループ認可（デフォルトで制限付き）:

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

## 配信ターゲット（CLI/cron）

`openclaw message send`やcron配信で以下を使用します:

- DM: `~sampel-palnet`または`dm/~sampel-palnet`
- グループ: `chat/~host-ship/channel`または`group:~host-ship/channel`

## 注意事項

- グループ返信は応答するためにメンション（例: `~your-bot-ship`）が必要です。
- スレッド返信: 受信メッセージがスレッド内にある場合、OpenClawはスレッド内で返信します。
- メディア: `sendMedia`はテキスト + URLにフォールバックします（ネイティブアップロードなし）。
