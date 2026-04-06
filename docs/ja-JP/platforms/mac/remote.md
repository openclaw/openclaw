---
read_when:
    - リモートMacコントロールのセットアップまたはデバッグ時
summary: リモートのOpenClaw Gateway ゲートウェイをSSH経由で操作するためのmacOSアプリフロー
title: リモートコントロール
x-i18n:
    generated_at: "2026-04-02T08:34:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d10386ea66d01cca7aafa2bbe2cd3b21df01b46c5958f5e6cd5fa2eed68af378
    source_path: platforms/mac/remote.md
    workflow: 15
---

# リモートOpenClaw（macOS ⇄ リモートホスト）

このフローでは、macOSアプリを別のホスト（デスクトップ/サーバー）で動作するOpenClaw Gateway ゲートウェイのフルリモートコントロールとして使用できます。これはアプリの **Remote over SSH**（リモート実行）機能です。ヘルスチェック、Voice Wake転送、Web Chatなどすべての機能が、_Settings → General_ の同じリモートSSH設定を再利用します。

## モード

- **Local (this Mac)**: すべてがローカルのラップトップ上で動作します。SSHは不要です。
- **Remote over SSH（デフォルト）**: OpenClawコマンドはリモートホスト上で実行されます。macアプリは `-o BatchMode` と選択したID/キーを使ってSSH接続を開き、ローカルポートフォワーディングを行います。
- **Remote direct (ws/wss)**: SSHトンネルなし。macアプリが Gateway ゲートウェイURLに直接接続します（例: Tailscale Serveやパブリック HTTPSリバースプロキシ経由）。

## リモートトランスポート

リモートモードは2つのトランスポートをサポートしています:

- **SSHトンネル**（デフォルト）: `ssh -N -L ...` を使用して Gateway ゲートウェイポートをlocalhostにフォワードします。トンネルがloopbackであるため、Gateway ゲートウェイからはノードのIPが `127.0.0.1` として見えます。
- **Direct (ws/wss)**: Gateway ゲートウェイURLに直接接続します。Gateway ゲートウェイからは実際のクライアントIPが見えます。

## リモートホストの前提条件

1. Node + pnpmをインストールし、OpenClaw CLIをビルド/インストールします（`pnpm install && pnpm build && pnpm link --global`）。
2. 非対話型シェルで `openclaw` がPATH上にあることを確認します（必要に応じて `/usr/local/bin` や `/opt/homebrew/bin` にシンボリックリンクを作成します）。
3. キー認証でSSHを開きます。LAN外からの安定した到達性には **Tailscale** IPの使用を推奨します。

## macOSアプリのセットアップ

1. _Settings → General_ を開きます。
2. **OpenClaw runs** で **Remote over SSH** を選択し、以下を設定します:
   - **Transport**: **SSH tunnel** または **Direct (ws/wss)**。
   - **SSH target**: `user@host`（オプションで `:port`）。
     - Gateway ゲートウェイが同じLAN上にあり、Bonjourをアドバタイズしている場合、検出リストから選択してこのフィールドを自動入力できます。
   - **Gateway URL**（Directのみ）: `wss://gateway.example.ts.net`（またはローカル/LAN向けに `ws://...`）。
   - **Identity file**（詳細設定）: キーのパス。
   - **Project root**（詳細設定）: コマンドに使用されるリモートのチェックアウトパス。
   - **CLI path**（詳細設定）: 実行可能な `openclaw` エントリーポイント/バイナリへのオプションパス（アドバタイズされている場合は自動入力）。
3. **Test remote** をクリックします。成功はリモートの `openclaw status --json` が正しく実行されたことを示します。失敗は通常PATH/CLIの問題を意味します。exit 127はリモートでCLIが見つからないことを意味します。
4. ヘルスチェックとWeb Chatは、このSSHトンネルを通じて自動的に動作するようになります。

## Web Chat

- **SSHトンネル**: Web Chatは、フォワードされたWebSocketコントロールポート（デフォルト18789）経由で Gateway ゲートウェイに接続します。
- **Direct (ws/wss)**: Web Chatは設定された Gateway ゲートウェイURLに直接接続します。
- 個別のWebChat HTTPサーバーはもうありません。

## 権限

- リモートホストには、ローカルと同じTCC承認が必要です（Automation、Accessibility、Screen Recording、Microphone、Speech Recognition、Notifications）。そのマシンでオンボーディングを実行して一度承認します。
- ノードは `node.list` / `node.describe` を通じて権限の状態をアドバタイズするため、エージェントは利用可能な機能を把握できます。

## セキュリティに関する注意

- リモートホストではloopbackバインドを推奨し、SSHまたは Tailscale 経由で接続してください。
- SSHトンネルは厳密なホストキーチェックを使用します。`~/.ssh/known_hosts` にホストキーが存在するよう、先にホストキーを信頼してください。
- Gateway ゲートウェイを非loopbackインターフェースにバインドする場合は、トークン/パスワード認証を必須にしてください。
- [セキュリティ](/gateway/security) と [Tailscale](/gateway/tailscale) を参照してください。

## WhatsAppログインフロー（リモート）

- **リモートホスト上で** `openclaw channels login --verbose` を実行します。スマートフォンのWhatsAppでQRコードをスキャンします。
- 認証が期限切れになった場合は、そのホストでログインを再実行します。ヘルスチェックがリンクの問題を表面化させます。

## トラブルシューティング

- **exit 127 / not found**: 非ログインシェルで `openclaw` がPATH上にありません。`/etc/paths`、シェルrc、または `/usr/local/bin`/`/opt/homebrew/bin` へのシンボリックリンクで追加してください。
- **Health probe failed**: SSHの到達性、PATH、およびBaileysがログインしていること（`openclaw status --json`）を確認してください。
- **Web Chat stuck**: リモートホストで Gateway ゲートウェイが実行中であること、フォワードされたポートが Gateway ゲートウェイのWSポートと一致していることを確認してください。UIには正常なWS接続が必要です。
- **Node IP shows 127.0.0.1**: SSHトンネルでは想定通りです。Gateway ゲートウェイに実際のクライアントIPを認識させたい場合は、**Transport** を **Direct (ws/wss)** に切り替えてください。
- **Voice Wake**: リモートモードではトリガーフレーズが自動的に転送されます。個別のフォワーダーは不要です。

## 通知サウンド

`openclaw` と `node.invoke` を使ったスクリプトで通知ごとにサウンドを選択できます。例:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

アプリにはグローバルな「デフォルトサウンド」トグルはもうありません。呼び出し元がリクエストごとにサウンド（またはなし）を選択します。
