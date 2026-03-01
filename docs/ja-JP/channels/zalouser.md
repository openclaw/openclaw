---
summary: "zca-cli（QRログイン）によるZalo個人アカウントのサポート、機能、設定"
read_when:
  - OpenClawのZalo Personalを設定するとき
  - Zalo Personalのログインやメッセージフローをデバッグするとき
title: "Zalo Personal"
---

# Zalo Personal（非公式）

ステータス: 実験的。この統合は`zca-cli`を介して**個人のZaloアカウント**を自動化します。

> **警告:** これは非公式の統合であり、アカウントの停止/バンにつながる可能性があります。自己責任で使用してください。

## プラグインが必要です

Zalo Personalはプラグインとして提供されており、コアインストールにはバンドルされていません。

- CLI経由でインストール: `openclaw plugins install @openclaw/zalouser`
- またはソースチェックアウトから: `openclaw plugins install ./extensions/zalouser`
- 詳細: [プラグイン](/tools/plugin)

## 前提条件: zca-cli

Gatewayマシンの`PATH`に`zca`バイナリが利用可能である必要があります。

- 確認: `zca --version`
- 見つからない場合は、zca-cliをインストールしてください（`extensions/zalouser/README.md`またはアップストリームのzca-cliドキュメントを参照）。

## クイックセットアップ（初心者向け）

1. プラグインをインストールします（上記参照）。
2. ログイン（QR、Gatewayマシンで）:
   - `openclaw channels login --channel zalouser`
   - ターミナルのQRコードをZaloモバイルアプリでスキャンします。
3. チャンネルを有効にします:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Gatewayを再起動します（またはオンボーディングを完了します）。
5. DMアクセスはデフォルトでペアリングです。最初の連絡時にペアリングコードを承認してください。

## 概要

- `zca listen`を使用して受信メッセージを受信します。
- `zca msg ...`を使用して返信を送信します（テキスト/メディア/リンク）。
- Zalo Bot APIが利用できない「個人アカウント」ユースケース向けに設計されています。

## 命名

チャンネルIDは`zalouser`で、これが**個人のZaloユーザーアカウント**（非公式）を自動化することを明示しています。将来の公式Zalo API統合の可能性のために`zalo`を予約しています。

## IDの検索（ディレクトリ）

ディレクトリCLIを使用してピア/グループとそのIDを検索します:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 制限事項

- 送信テキストは約2000文字で分割されます（Zaloクライアントの制限）。
- ストリーミングはデフォルトでブロックされています。

## アクセス制御（DM）

`channels.zalouser.dmPolicy`は以下をサポートします: `pairing | allowlist | open | disabled`（デフォルト: `pairing`）。
`channels.zalouser.allowFrom`はユーザーIDまたは名前を受け入れます。ウィザードは`zca friend find`が利用可能な場合、名前をIDに解決します。

承認方法:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## グループアクセス（オプション）

- デフォルト: `channels.zalouser.groupPolicy = "open"`（グループ許可）。`channels.defaults.groupPolicy`でデフォルトをオーバーライドできます。
- 許可リストで制限:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（キーはグループIDまたは名前）
- すべてのグループをブロック: `channels.zalouser.groupPolicy = "disabled"`。
- 設定ウィザードはグループ許可リストの入力を求めることができます。
- 起動時にOpenClawは許可リスト内のグループ/ユーザー名をIDに解決し、マッピングをログに記録します。未解決のエントリは入力されたまま保持されます。

例:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## マルチアカウント

アカウントはzcaプロファイルにマッピングされます。例:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## トラブルシューティング

**`zca`が見つからない:**

- zca-cliをインストールし、Gatewayプロセスの`PATH`にあることを確認してください。

**ログインが維持されない:**

- `openclaw channels status --probe`
- 再ログイン: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
