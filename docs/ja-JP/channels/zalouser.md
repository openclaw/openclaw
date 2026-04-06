---
read_when:
    - OpenClawでZalo Personalをセットアップする
    - Zalo Personalのログインやメッセージフローをデバッグする
summary: zca-js（QRログイン）によるZalo個人アカウントのネイティブサポート、機能、設定
title: Zalo Personal
x-i18n:
    generated_at: "2026-04-02T07:32:17Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: babfd49df8a673ab293c9cd60a7ff8a56653f16a314f532c3e32e0790391ecf2
    source_path: channels/zalouser.md
    workflow: 15
---

# Zalo Personal（非公式）

ステータス: 実験的。この連携はOpenClaw内でネイティブの`zca-js`を使用して**個人Zaloアカウント**を自動化します。

> **警告:** これは非公式の連携であり、アカウントの停止やBANにつながる可能性があります。自己責任でご利用ください。

## プラグインが必要です

Zalo Personalはプラグインとして提供されており、コアインストールにはバンドルされていません。

- CLIでインストール: `openclaw plugins install @openclaw/zalouser`
- またはソースチェックアウトから: `openclaw plugins install ./path/to/local/zalouser-plugin`
- 詳細: [プラグイン](/tools/plugin)

外部の`zca`/`openzca` CLIバイナリは不要です。

## クイックセットアップ（初心者向け）

1. プラグインをインストールします（上記参照）。
2. ログイン（QR、Gateway ゲートウェイマシン上で）:
   - `openclaw channels login --channel zalouser`
   - ZaloモバイルアプリでQRコードをスキャンします。
3. チャネルを有効にします:

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

4. Gateway ゲートウェイを再起動します（またはセットアップを完了します）。
5. ダイレクトメッセージのアクセスはデフォルトでペアリングです。初回接触時にペアリングコードを承認してください。

## 概要

- `zca-js`を使用して完全にインプロセスで動作します。
- ネイティブのイベントリスナーを使用して受信メッセージを受け取ります。
- JS API（テキスト/メディア/リンク）を通じて直接返信を送信します。
- Zalo Bot APIが利用できない場合の「個人アカウント」ユースケース向けに設計されています。

## 命名

チャネルIDは`zalouser`です。これは**個人Zaloユーザーアカウント**（非公式）を自動化することを明示するためです。将来の公式Zalo API連携のために`zalo`を予約しています。

## IDの検索（ディレクトリ）

ディレクトリCLIを使用してピア/グループとそのIDを検索できます:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 制限事項

- 送信テキストは約2000文字で分割されます（Zaloクライアントの制限）。
- ストリーミングはデフォルトでブロックされています。

## アクセス制御（ダイレクトメッセージ）

`channels.zalouser.dmPolicy`は`pairing | allowlist | open | disabled`をサポートします（デフォルト: `pairing`）。

`channels.zalouser.allowFrom`はユーザーIDまたは名前を受け付けます。セットアップ時に、プラグインのインプロセス連絡先検索を使用して名前がIDに解決されます。

承認方法:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## グループアクセス（オプション）

- デフォルト: `channels.zalouser.groupPolicy = "open"`（グループ許可）。未設定時のデフォルトを上書きするには`channels.defaults.groupPolicy`を使用してください。
- 許可リストで制限:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（キーは安定したグループIDにしてください。名前は起動時に可能な限りIDに解決されます）
  - `channels.zalouser.groupAllowFrom`（許可されたグループ内でボットをトリガーできる送信者を制御します）
- すべてのグループをブロック: `channels.zalouser.groupPolicy = "disabled"`。
- 設定ウィザードでグループ許可リストの入力を求めることができます。
- 起動時にOpenClawは許可リスト内のグループ/ユーザー名をIDに解決し、マッピングをログに記録します。
- グループ許可リストのマッチングはデフォルトでIDのみです。未解決の名前は`channels.zalouser.dangerouslyAllowNameMatching: true`が有効でない限り、認証では無視されます。
- `channels.zalouser.dangerouslyAllowNameMatching: true`は、変更可能なグループ名マッチングを再度有効にする緊急互換モードです。
- `groupAllowFrom`が未設定の場合、ランタイムはグループ送信者チェックに`allowFrom`をフォールバックします。
- 送信者チェックは通常のグループメッセージと制御コマンド（例: `/new`、`/reset`）の両方に適用されます。

例:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["1471383327500481391"],
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

### グループメンションゲーティング

- `channels.zalouser.groups.<group>.requireMention`でグループ返信にメンションが必要かどうかを制御します。
- 解決順序: 完全一致のグループID/名前 -> 正規化されたグループスラッグ -> `*` -> デフォルト（`true`）。
- これは許可リストのグループとオープングループモードの両方に適用されます。
- 承認された制御コマンド（例: `/new`）はメンションゲーティングをバイパスできます。
- メンションが必要なためにグループメッセージがスキップされた場合、OpenClawはそれを保留中のグループ履歴として保存し、次に処理されるグループメッセージに含めます。
- グループ履歴の上限はデフォルトで`messages.groupChat.historyLimit`（フォールバック`50`）です。`channels.zalouser.historyLimit`でアカウントごとに上書きできます。

例:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "*": { allow: true, requireMention: true },
        "Work Chat": { allow: true, requireMention: false },
      },
    },
  },
}
```

## マルチアカウント

アカウントはOpenClawの状態内で`zalouser`プロファイルにマッピングされます。例:

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

## タイピング、リアクション、配信確認

- OpenClawは返信を送信する前にタイピングイベントを送信します（ベストエフォート）。
- メッセージリアクションアクション`react`はチャネルアクションで`zalouser`に対応しています。
  - `remove: true`を使用して、メッセージから特定のリアクション絵文字を削除できます。
  - リアクションのセマンティクス: [リアクション](/tools/reactions)
- イベントメタデータを含む受信メッセージに対して、OpenClawは配信済み＋既読の確認を送信します（ベストエフォート）。

## トラブルシューティング

**ログインが維持されない:**

- `openclaw channels status --probe`
- 再ログイン: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**許可リスト/グループ名が解決されなかった:**

- `allowFrom`/`groupAllowFrom`/`groups`には数値IDを使用するか、正確なフレンド/グループ名を使用してください。

**古いCLIベースのセットアップからアップグレードした場合:**

- 古い外部`zca`プロセスの前提を削除してください。
- チャネルは外部CLIバイナリなしで完全にOpenClaw内で動作するようになりました。

## 関連

- [チャネル概要](/channels) — サポートされているすべてのチャネル
- [ペアリング](/channels/pairing) — ダイレクトメッセージの認証とペアリングフロー
- [グループ](/channels/groups) — グループチャットの動作とメンションゲーティング
- [チャネルルーティング](/channels/channel-routing) — メッセージのセッションルーティング
- [セキュリティ](/gateway/security) — アクセスモデルと堅牢化
