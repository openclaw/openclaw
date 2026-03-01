---
summary: "SSH経由でリモートOpenClaw Gatewayを制御するmacOSアプリのフロー"
read_when:
  - リモートMac制御のセットアップまたはデバッグ
title: "リモートコントロール"
---

# リモートOpenClaw（macOS ⇄ リモートホスト）

このフローにより、macOSアプリは別のホスト（デスクトップ/サーバー）で実行されているOpenClaw Gatewayのフルリモートコントロールとして機能します。これはアプリの**Remote over SSH**（リモート実行）機能です。ヘルスチェック、Voice Wake転送、Web Chatなどのすべての機能は、_Settings → General_ の同じリモートSSH設定を再利用します。

## モード

- **Local (this Mac)**：すべてがラップトップ上で実行されます。SSHは不要です。
- **Remote over SSH（デフォルト）**：OpenClawコマンドはリモートホストで実行されます。macアプリは`-o BatchMode`と選択したID/キー、およびローカルポートフォワードでSSH接続を開きます。
- **Remote direct (ws/wss)**：SSHトンネルなし。macアプリはGateway URLに直接接続します（例：Tailscale ServeやパブリックHTTPSリバースプロキシ経由）。

## リモートトランスポート

リモートモードは2つのトランスポートをサポートします：

- **SSHトンネル**（デフォルト）：`ssh -N -L ...`を使用してGatewayポートをlocalhostにフォワードします。トンネルがループバックであるため、GatewayはノードのIPを`127.0.0.1`として認識します。
- **Direct (ws/wss)**：Gateway URLに直接接続します。Gatewayは実際のクライアントIPを認識します。

## リモートホストの前提条件

1. Node + pnpmをインストールし、OpenClaw CLIをビルド/インストールします（`pnpm install && pnpm build && pnpm link --global`）。
2. 非インタラクティブシェルのPATHに`openclaw`が含まれていることを確認します（必要に応じて`/usr/local/bin`または`/opt/homebrew/bin`にシンボリックリンクを作成）。
3. キー認証でSSHを開きます。LAN外からの安定した到達性のために**Tailscale** IPを推奨します。

## macOSアプリのセットアップ

1. _Settings → General_ を開きます。
2. **OpenClaw runs** で **Remote over SSH** を選択し、以下を設定します：
   - **Transport**：**SSH tunnel** または **Direct (ws/wss)**。
   - **SSH target**：`user@host`（オプション`:port`）。
     - GatewayがBonjourをアドバタイズしている同一LAN上にある場合、検出されたリストから選択してこのフィールドを自動入力できます。
   - **Gateway URL**（Directのみ）：`wss://gateway.example.ts.net`（またはローカル/LANの場合は`ws://...`）。
   - **Identity file**（詳細設定）：キーへのパス。
   - **Project root**（詳細設定）：コマンドに使用されるリモートのチェックアウトパス。
   - **CLI path**（詳細設定）：実行可能な`openclaw`エントリポイント/バイナリへのオプションパス（アドバタイズ時に自動入力）。
3. **Test remote** を押します。成功すると、リモートの`openclaw status --json`が正しく実行されたことを示します。失敗は通常PATH/CLIの問題を意味します。exit 127はCLIがリモートで見つからないことを意味します。
4. ヘルスチェックとWeb Chatは、このSSHトンネルを通じて自動的に実行されるようになります。

## Web Chat

- **SSHトンネル**：Web ChatはフォワードされたWebSocketコントロールポート（デフォルト18789）を介してGatewayに接続します。
- **Direct (ws/wss)**：Web Chatは設定されたGateway URLに直接接続します。
- 別個のWebChat HTTPサーバーはもうありません。

## パーミッション

- リモートホストにはローカルと同じTCC承認が必要です（Automation、Accessibility、Screen Recording、Microphone、Speech Recognition、Notifications）。そのマシンでオンボーディングを実行して一度付与してください。
- ノードは`node.list` / `node.describe`を介してパーミッション状態をアドバタイズするため、エージェントは何が利用可能かを把握できます。

## セキュリティに関する注意事項

- リモートホストではループバックバインドを推奨し、SSHまたはTailscale経由で接続してください。
- SSHトンネリングは厳密なホストキーチェックを使用します。`~/.ssh/known_hosts`に存在するように、まずホストキーを信頼してください。
- Gatewayを非ループバックインターフェースにバインドする場合は、トークン/パスワード認証を要求してください。
- [セキュリティ](/gateway/security)と[Tailscale](/gateway/tailscale)を参照してください。

## WhatsAppログインフロー（リモート）

- **リモートホストで**`openclaw channels login --verbose`を実行します。スマートフォンのWhatsAppでQRをスキャンしてください。
- 認証が期限切れの場合は、そのホストで再度ログインを実行します。ヘルスチェックがリンクの問題を表面化します。

## トラブルシューティング

- **exit 127 / not found**：非ログインシェルのPATHに`openclaw`がありません。`/etc/paths`、シェルrc、または`/usr/local/bin`/`/opt/homebrew/bin`へのシンボリックリンクで追加してください。
- **ヘルスプローブ失敗**：SSHの到達性、PATH、Baileysがログイン済みであること（`openclaw status --json`）を確認してください。
- **Web Chatがスタック**：リモートホストでGatewayが実行中であり、フォワードされたポートがGateway WSポートと一致することを確認してください。UIは正常なWS接続を必要とします。
- **ノードIPが127.0.0.1と表示**：SSHトンネルでは想定どおりです。Gatewayに実際のクライアントIPを認識させたい場合は、**Transport**を**Direct (ws/wss)**に切り替えてください。
- **Voice Wake**：リモートモードではトリガーフレーズが自動的に転送されます。別途フォワーダーは不要です。

## 通知音

スクリプトで`openclaw`と`node.invoke`を使用して通知ごとにサウンドを選択できます。例：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

アプリにはグローバルな「デフォルトサウンド」トグルはもうありません。呼び出し元がリクエストごとにサウンド（またはなし）を選択します。
