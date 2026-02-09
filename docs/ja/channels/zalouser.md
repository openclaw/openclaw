---
summary: "zca-cli（QR ログイン）による Zalo 個人アカウントのサポート、機能、および設定"
read_when:
  - OpenClaw 用の Zalo Personal をセットアップする場合
  - Zalo Personal のログインやメッセージフローをデバッグする場合
title: "Zalo Personal"
---

# Zalo Personal（非公式）

状態: 実験的。 ステータス: 実験的。この統合は `zca-cli` を介して **個人の Zalo アカウント** を自動化します。

> **警告:** これは非公式の統合であり、アカウント停止／BAN につながる可能性があります。自己責任で使用してください。 ご自身の責任においてご利用ください。

## 必要なプラグイン

Zalo Personal はプラグインとして提供され、コアインストールには同梱されていません。

- CLI でインストール: `openclaw plugins install @openclaw/zalouser`
- またはソースチェックアウトから: `openclaw plugins install ./extensions/zalouser`
- 詳細: [Plugins](/tools/plugin)

## 前提条件: zca-cli

Gateway マシンには、`PATH` に `zca` バイナリが存在する必要があります。

- 確認: `zca --version`
- 見つからない場合は zca-cli をインストールしてください（`extensions/zalouser/README.md` または上流の zca-cli ドキュメントを参照）。

## クイックセットアップ（初心者向け）

1. プラグインをインストールします（上記参照）。
2. ログイン（Gateway マシン上で QR）:
   - `openclaw channels login --channel zalouser`
   - ターミナルに表示される QR コードを Zalo モバイルアプリでスキャンします。
3. チャンネルを有効化します:

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

4. Gateway を再起動します（またはオンボーディングを完了します）。
5. ダイレクトメッセージ（DM）のアクセスはデフォルトでペアリングです。初回接触時にペアリングコードを承認してください。

## これは何か

- 受信メッセージの受信に `zca listen` を使用します。
- 返信（テキスト／メディア／リンク）の送信に `zca msg ...` を使用します。
- Zalo Bot API が利用できない「個人アカウント」用途向けに設計されています。

## 命名

チャンネル ID は `zalouser` です。**個人の Zalo ユーザーアカウント**（非公式）を自動化することを明確にするためです。将来の公式 Zalo API 統合の可能性に備え、`zalo` は予約しています。 「zalo」は将来の公式Zalo API統合のために予約されています。

## ID の検索（ディレクトリ）

ディレクトリ CLI を使用して、ピア／グループとそれらの ID を発見します。

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 制限

- 送信テキストは約 2000 文字で分割されます（Zalo クライアントの制限）。
- ストリーミングはデフォルトでブロックされます。

## アクセス制御（DM）

`channels.zalouser.dmPolicy` は `pairing | allowlist | open | disabled` をサポートします（デフォルト: `pairing`）。
`channels.zalouser.allowFrom` はユーザー ID または名前を受け付けます。ウィザードは、利用可能な場合に `zca friend find` を介して名前を ID に解決します。
`channels.zalouser.allowFrom` はユーザーIDまたは名前を受け付けます。 利用可能な場合、ウィザードは「zca friend find」を介して名前をIDに解決します。

承認方法:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## グループアクセス（任意）

- デフォルト: `channels.zalouser.groupPolicy = "open"`（グループを許可）。未設定の場合、`channels.defaults.groupPolicy` を使用して既定値を上書きできます。 .tools`: チャンネル上書きがない場合に使用される、チームごとのデフォルトツールポリシー上書き（`allow`/`deny`/`alsoAllow\`）。
- 許可リストで制限するには:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（キーはグループ ID または名前）
- すべてのグループをブロック: `channels.zalouser.groupPolicy = "disabled"`。
- 設定ウィザードはグループ許可リストの入力を促すことがあります。
- 起動時に OpenClaw は許可リスト内のグループ／ユーザー名を ID に解決して対応関係をログに記録します。解決できないエントリは入力どおり保持されます。

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

アカウントは zca プロファイルにマッピングされます。例: 2026-02-08T09:22:13Z

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

**`zca` が見つからない:**

- zca-cli をインストールし、Gateway プロセスの `PATH` に含まれていることを確認してください。

**ログインが保持されない:**

- `openclaw channels status --probe`
- 再ログイン: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
