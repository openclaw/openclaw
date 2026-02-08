---
summary: 「imsg（stdio 上の JSON-RPC）によるレガシー iMessage サポート。新規セットアップでは BlueBubbles の使用を推奨します。」
read_when:
  - iMessage サポートのセットアップ
  - iMessage の送受信のデバッグ
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:10Z
---

# iMessage（レガシー: imsg）

> **推奨:** 新しい iMessage セットアップでは [BlueBubbles](/channels/bluebubbles) を使用してください。
>
> `imsg` チャンネルはレガシーな外部 CLI 統合であり、将来のリリースで削除される可能性があります。

ステータス: レガシーな外部 CLI 統合。Gateway は `imsg rpc`（stdio 上の JSON-RPC）を起動します。

## クイックセットアップ（初心者）

1. この Mac で Messages にサインインされていることを確認します。
2. `imsg` をインストールします:
   - `brew install steipete/tap/imsg`
3. `channels.imessage.cliPath` と `channels.imessage.dbPath` を使用して OpenClaw を設定します。
4. ゲートウェイを起動し、macOS のプロンプト（オートメーション + フルディスクアクセス）を承認します。

最小構成:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## これは何か

- macOS 上の `imsg` によって支えられた iMessage チャンネルです。
- 決定的ルーティング: 返信は常に iMessage に戻ります。
- ダイレクトメッセージはエージェントのメイン セッションを共有し、グループは分離されます（`agent:<agentId>:imessage:group:<chat_id>`）。
- 複数参加者のスレッドが `is_group=false` で届いた場合でも、`channels.imessage.groups` を使用して `chat_id` することで分離できます（下記「Group-ish threads」を参照）。

## Config の書き込み

デフォルトでは、iMessage は `/config set|unset` によってトリガーされる Config 更新の書き込みが許可されています（`commands.config: true` が必要）。

無効化するには:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## 要件

- Messages にサインイン済みの macOS。
- OpenClaw と `imsg` に対するフルディスクアクセス（Messages DB へのアクセス）。
- 送信時のオートメーション権限。
- `channels.imessage.cliPath` は、stdin/stdout をプロキシする任意のコマンドを指せます（例: 別の Mac に SSH して `imsg rpc` を実行するラッパースクリプト）。

## macOS プライバシーとセキュリティ TCC のトラブルシューティング

送受信が失敗する場合（例: `imsg rpc` が非ゼロで終了する、タイムアウトする、またはゲートウェイがハングしているように見える）、macOS の権限プロンプトが承認されていないことが一般的な原因です。

macOS はアプリ／プロセスのコンテキストごとに TCC 権限を付与します。`imsg` を実行するのと同じコンテキスト（例: Terminal / iTerm、LaunchAgent セッション、または SSH 起動プロセス）でプロンプトを承認してください。

チェックリスト:

- **フルディスクアクセス**: OpenClaw を実行しているプロセス（および `imsg` を実行する任意のシェル／SSH ラッパー）にアクセスを許可します。これは Messages データベース（`chat.db`）の読み取りに必要です。
- **オートメーション → Messages**: 送信のために、OpenClaw を実行しているプロセス（および／またはターミナル）に **Messages.app** の制御を許可します。
- **`imsg` CLI の健全性**: `imsg` がインストールされており、RPC（`imsg rpc --help`）をサポートしていることを確認します。

ヒント: OpenClaw がヘッドレス（LaunchAgent / systemd / SSH）で実行されている場合、macOS のプロンプトは見逃しやすくなります。GUI ターミナルで一度だけ対話的なコマンドを実行してプロンプトを強制表示し、その後再試行してください:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

関連する macOS フォルダー権限（デスクトップ／書類／ダウンロード）: [/platforms/mac/permissions](/platforms/mac/permissions)。

## セットアップ（高速パス）

1. この Mac で Messages にサインインされていることを確認します。
2. iMessage を設定し、ゲートウェイを起動します。

### 専用ボット macOS ユーザー（アイデンティティ分離用）

ボットを **別の iMessage アイデンティティ** から送信させ（個人の Messages をクリーンに保つ）たい場合は、専用の Apple ID と専用の macOS ユーザーを使用します。

1. 専用の Apple ID を作成します（例: `my-cool-bot@icloud.com`）。
   - Apple は確認／2FA のために電話番号を要求する場合があります。
2. macOS ユーザーを作成し（例: `openclawhome`）、そのユーザーでサインインします。
3. その macOS ユーザーで Messages を開き、ボット用 Apple ID で iMessage にサインインします。
4. リモートログインを有効化します（システム設定 → 一般 → 共有 → リモートログイン）。
5. `imsg` をインストールします:
   - `brew install steipete/tap/imsg`
6. `ssh <bot-macos-user>@localhost true` がパスワードなしで動作するように SSH を設定します。
7. ボットユーザーとして `imsg` を実行する SSH ラッパーを指すよう、`channels.imessage.accounts.bot.cliPath` を設定します。

初回実行時の注意: 送受信には、_ボット macOS ユーザー_ での GUI 承認（オートメーション + フルディスクアクセス）が必要になる場合があります。`imsg rpc` が停止しているように見える、または終了する場合は、そのユーザーでログイン（画面共有が便利）し、一度だけ `imsg chats --limit 1` / `imsg send ...` を実行してプロンプトを承認してから再試行してください。[macOS プライバシーとセキュリティ TCC のトラブルシューティング](#troubleshooting-macos-privacy-and-security-tcc) を参照してください。

ラッパーの例（`chmod +x`）。`<bot-macos-user>` を実際の macOS ユーザー名に置き換えてください:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

設定例:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

単一アカウント構成では、`accounts` マップの代わりにフラットなオプション（`channels.imessage.cliPath`、`channels.imessage.dbPath`）を使用してください。

### リモート／SSH バリアント（任意）

別の Mac で iMessage を使用したい場合は、SSH 経由でリモート macOS ホスト上の `imsg` を実行するラッパーを指すよう、`channels.imessage.cliPath` を設定します。OpenClaw は stdio のみを必要とします。

ラッパーの例:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**リモート添付ファイル:** `cliPath` が SSH 経由でリモートホストを指す場合、Messages データベース内の添付ファイルパスはリモートマシン上のファイルを参照します。`channels.imessage.remoteHost` を設定することで、OpenClaw は SCP 経由で自動的に取得できます:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

`remoteHost` が設定されていない場合、OpenClaw はラッパースクリプト内の SSH コマンドを解析して自動検出を試みます。信頼性のため、明示的な設定を推奨します。

#### Tailscale 経由のリモート Mac（例）

Gateway が Linux ホスト／VM 上で動作し、iMessage は Mac 上で動作させる必要がある場合、Tailscale が最も簡単なブリッジです。Gateway は tailnet 経由で Mac と通信し、SSH で `imsg` を実行し、添付ファイルを SCP で取得します。

アーキテクチャ:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

具体的な設定例（Tailscale ホスト名）:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

ラッパー例（`~/.openclaw/scripts/imsg-ssh`）:

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

注記:

- Mac が Messages にサインインしており、リモートログインが有効であることを確認してください。
- `ssh bot@mac-mini.tailnet-1234.ts.net` がプロンプトなしで動作するように SSH 鍵を使用してください。
- 添付ファイルを SCP で取得できるよう、`remoteHost` は SSH の接続先と一致させてください。

マルチアカウント対応: アカウントごとの設定と任意の `name` を用いて `channels.imessage.accounts` を使用します。共通パターンについては [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。`~/.openclaw/openclaw.json` は（トークンを含むことが多いため）コミットしないでください。

## アクセス制御（DM + グループ）

DM:

- デフォルト: `channels.imessage.dmPolicy = "pairing"`。
- 不明な送信者にはペアリングコードが送信され、承認されるまでメッセージは無視されます（コードは 1 時間で期限切れ）。
- 承認方法:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- ペアリングは iMessage DM のデフォルトのトークン交換です。詳細: [Pairing](/channels/pairing)

グループ:

- `channels.imessage.groupPolicy = open | allowlist | disabled`。
- `allowlist` が設定されている場合、`channels.imessage.groupAllowFrom` がグループでのトリガー可能者を制御します。
- iMessage にはネイティブのメンション メタデータがないため、メンション ゲーティングには `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）を使用します。
- マルチエージェント上書き: `agents.list[].groupChat.mentionPatterns` にエージェントごとのパターンを設定します。

## 仕組み（挙動）

- `imsg` がメッセージイベントをストリームし、ゲートウェイが共有チャンネル エンベロープに正規化します。
- 返信は常に同じチャット ID またはハンドルにルーティングされます。

## Group-ish スレッド（`is_group=false`）

一部の iMessage スレッドは複数の参加者を持ちますが、Messages がチャット識別子を保存する方法により、`is_group=false` で届くことがあります。

`channels.imessage.groups` の下に `chat_id` を明示的に設定すると、OpenClaw はそのスレッドを次の用途で「グループ」として扱います:

- セッション分離（個別の `agent:<agentId>:imessage:group:<chat_id>` セッションキー）
- グループ許可リスト／メンション ゲーティングの挙動

例:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

これは、特定のスレッドに対して分離された人格／モデルを使用したい場合に有用です（[マルチエージェント ルーティング](/concepts/multi-agent) を参照）。ファイルシステムの分離については [サンドボックス化](/gateway/sandboxing) を参照してください。

## メディア + 制限

- `channels.imessage.includeAttachments` による添付ファイルの取り込み（任意）。
- `channels.imessage.mediaMaxMb` によるメディア上限。

## 制限

- 送信テキストは `channels.imessage.textChunkLimit`（デフォルト 4000）に分割されます。
- 任意の改行分割: `channels.imessage.chunkMode="newline"` を設定すると、長さ分割の前に空行（段落境界）で分割します。
- メディアのアップロードは `channels.imessage.mediaMaxMb`（デフォルト 16）で制限されます。

## アドレス指定／配信先

安定したルーティングのため、`chat_id` を推奨します:

- `chat_id:123`（推奨）
- `chat_guid:...`
- `chat_identifier:...`
- 直接ハンドル: `imessage:+1555` / `sms:+1555` / `user@example.com`

チャット一覧:

```
imsg chats --limit 20
```

## 設定リファレンス（iMessage）

完全な設定: [設定](/gateway/configuration)

プロバイダー オプション:

- `channels.imessage.enabled`: チャンネル起動の有効／無効。
- `channels.imessage.cliPath`: `imsg` へのパス。
- `channels.imessage.dbPath`: Messages DB パス。
- `channels.imessage.remoteHost`: `cliPath` がリモート Mac を指す場合の、SCP 添付転送用 SSH ホスト（例: `user@gateway-host`）。未設定時は SSH ラッパーから自動検出されます。
- `channels.imessage.service`: `imessage | sms | auto`。
- `channels.imessage.region`: SMS リージョン。
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: ペアリング）。
- `channels.imessage.allowFrom`: DM 許可リスト（ハンドル、メール、E.164 番号、または `chat_id:*`）。`open` には `"*"` が必要です。iMessage にはユーザー名がないため、ハンドルまたはチャット ターゲットを使用してください。
- `channels.imessage.groupPolicy`: `open | allowlist | disabled`（デフォルト: 許可リスト）。
- `channels.imessage.groupAllowFrom`: グループ送信者許可リスト。
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: コンテキストとして含める最大グループ メッセージ数（0 で無効）。
- `channels.imessage.dmHistoryLimit`: ユーザー ターン数での DM 履歴上限。ユーザーごとの上書き: `channels.imessage.dms["<handle>"].historyLimit`。
- `channels.imessage.groups`: グループごとのデフォルト + 許可リスト（グローバル デフォルトには `"*"` を使用）。
- `channels.imessage.includeAttachments`: 添付ファイルをコンテキストに取り込む。
- `channels.imessage.mediaMaxMb`: 受信／送信メディア上限（MB）。
- `channels.imessage.textChunkLimit`: 送信チャンク サイズ（文字数）。
- `channels.imessage.chunkMode`: 長さ分割の前に空行（段落境界）で分割する `newline`、または `length`（デフォルト）。

関連するグローバル オプション:

- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。
