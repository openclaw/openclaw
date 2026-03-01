---
summary: "隔離またはiMessageが必要な場合に、サンドボックス化されたmacOS VM（ローカルまたはホスト型）でOpenClawを実行する"
read_when:
  - メインのmacOS環境からOpenClawを隔離したい場合
  - サンドボックスでiMessage統合（BlueBubbles）が必要な場合
  - クローン可能なリセット可能なmacOS環境が必要な場合
  - ローカルとホスト型のmacOS VMオプションを比較したい場合
title: "macOS VM"
---

# macOS VM上のOpenClaw（サンドボックス化）

## 推奨デフォルト（ほとんどのユーザー向け）

- 常時稼働Gatewayと低コスト用の**小さなLinux VPS**。[VPSホスティング](/vps)を参照してください。
- 完全な制御とブラウザ自動化のための**住居用IP**が必要な場合は**専用ハードウェア**（Mac miniまたはLinuxボックス）。多くのサイトがデータセンターIPをブロックするため、ローカルブラウジングの方がうまく機能することが多いです。
- **ハイブリッド：** 安価なVPSにGatewayを保持し、ブラウザ/UI自動化が必要な場合はMacを**ノード**として接続します。[ノード](/nodes)と[Gatewayリモート](/gateway/remote)を参照してください。

macOS固有の機能（iMessage/BlueBubbles）が特に必要な場合、または日常のMacからの厳格な隔離が必要な場合にmacOS VMを使用してください。

## macOS VMオプション

### Apple Silicon Mac上のローカルVM（Lume）

[Lume](https://cua.ai/docs/lume)を使用して、既存のApple Silicon Mac上でサンドボックス化されたmacOS VMでOpenClawを実行します。

これにより以下が得られます：

- 隔離された完全なmacOS環境（ホストはクリーンなまま）
- BlueBubbles経由のiMessageサポート（Linux/Windowsでは不可能）
- VMのクローンによる即時リセット
- 追加のハードウェアやクラウドコストなし

### ホスト型Macプロバイダー（クラウド）

クラウド上のmacOSが必要な場合、ホスト型Macプロバイダーも動作します：

- [MacStadium](https://www.macstadium.com/)（ホスト型Mac）
- 他のホスト型Macベンダーも動作します。VM + SSHのドキュメントに従ってください

macOS VMへのSSHアクセスが確保できたら、以下のステップ6に進んでください。

---

## クイックパス（Lume、経験者向け）

1. Lumeをインストール
2. `lume create openclaw --os macos --ipsw latest`
3. セットアップアシスタントを完了し、リモートログイン（SSH）を有効化
4. `lume run openclaw --no-display`
5. SSHで接続し、OpenClawをインストールし、チャンネルを設定
6. 完了

---

## 必要なもの（Lume）

- Apple Silicon Mac（M1/M2/M3/M4）
- ホストにmacOS Sequoia以降
- VMごとに約60GBの空きディスク容量
- 約20分

---

## 1）Lumeのインストール

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin`がPATHに含まれていない場合：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

確認：

```bash
lume --version
```

ドキュメント：[Lumeインストール](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2）macOS VMの作成

```bash
lume create openclaw --os macos --ipsw latest
```

macOSをダウンロードしてVMを作成します。VNCウィンドウが自動的に開きます。

注意：接続速度によってダウンロードに時間がかかる場合があります。

---

## 3）セットアップアシスタントの完了

VNCウィンドウで：

1. 言語とリージョンを選択
2. Apple IDをスキップ（後でiMessageを使う場合はサインイン）
3. ユーザーアカウントを作成（ユーザー名とパスワードを覚えておいてください）
4. すべてのオプション機能をスキップ

セットアップ完了後、SSHを有効にしてください：

1. システム設定 → 一般 → 共有を開く
2. 「リモートログイン」を有効にする

---

## 4）VMのIPアドレスの取得

```bash
lume get openclaw
```

IPアドレス（通常`192.168.64.x`）を確認してください。

---

## 5）VMにSSHで接続

```bash
ssh youruser@192.168.64.X
```

`youruser`を作成したアカウントに、IPをVMのIPに置き換えてください。

---

## 6）OpenClawのインストール

VM内で：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

オンボーディングプロンプトに従って、モデルプロバイダー（Anthropic、OpenAIなど）をセットアップしてください。

---

## 7）チャンネルの設定

設定ファイルを編集：

```bash
nano ~/.openclaw/openclaw.json
```

チャンネルを追加：

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

その後、WhatsAppにログイン（QRスキャン）：

```bash
openclaw channels login
```

---

## 8）VMをヘッドレスで実行

VMを停止してディスプレイなしで再起動：

```bash
lume stop openclaw
lume run openclaw --no-display
```

VMはバックグラウンドで実行されます。OpenClawのデーモンがGatewayを稼働させ続けます。

ステータスの確認：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## ボーナス：iMessage統合

macOS上で実行する最大のメリットです。[BlueBubbles](https://bluebubbles.app)を使ってOpenClawにiMessageを追加できます。

VM内で：

1. bluebubbles.appからBlueBubblesをダウンロード
2. Apple IDでサインイン
3. Web APIを有効にしてパスワードを設定
4. BlueBubblesのWebhookをGatewayに向ける（例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

OpenClaw設定に追加：

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Gatewayを再起動してください。これでエージェントがiMessageの送受信を行えるようになります。

完全なセットアップの詳細：[BlueBubblesチャンネル](/channels/bluebubbles)

---

## ゴールデンイメージの保存

さらにカスタマイズする前に、クリーンな状態をスナップショットしてください：

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

いつでもリセット：

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24時間365日の実行

VMを稼働させ続けるには：

- Macを電源に接続したままにする
- システム設定 → 省エネルギーでスリープを無効にする
- 必要に応じて`caffeinate`を使用する

真の常時稼働には、専用のMac miniまたは小さなVPSを検討してください。[VPSホスティング](/vps)を参照してください。

---

## トラブルシューティング

| 問題                  | 解決策                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| VMにSSHできない        | VMのシステム設定で「リモートログイン」が有効になっていることを確認            |
| VMのIPが表示されない        | VMが完全に起動するまで待ち、`lume get openclaw`を再実行                           |
| Lumeコマンドが見つからない   | `~/.local/bin`をPATHに追加                                                    |
| WhatsApp QRがスキャンできない | `openclaw channels login`を実行する際にVM内（ホストではなく）にログインしていることを確認 |

---

## 関連ドキュメント

- [VPSホスティング](/vps)
- [ノード](/nodes)
- [Gatewayリモート](/gateway/remote)
- [BlueBubblesチャンネル](/channels/bluebubbles)
- [Lumeクイックスタート](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLIリファレンス](https://cua.ai/docs/lume/reference/cli-reference)
- [無人VMセットアップ](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（上級）
- [Dockerサンドボックス](/install/docker)（代替の隔離アプローチ）
