---
read_when:
    - OpenClawをメインのmacOS環境から分離したい場合
    - サンドボックス内でiMessage連携（BlueBubbles）を使いたい場合
    - クローン可能なリセット可能なmacOS環境が欲しい場合
    - ローカルとホスト型のmacOS VMオプションを比較したい場合
summary: 分離またはiMessageが必要な場合に、サンドボックス化されたmacOS VM（ローカルまたはホスト型）でOpenClawを実行する
title: macOS VM
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: b1f7c5691fd2686418ee25f2c38b1f9badd511daeef2906d21ad30fb523b013f
    source_path: install/macos-vm.md
    workflow: 15
---

# macOS VM上のOpenClaw（サンドボックス化）

## 推奨のデフォルト（ほとんどのユーザー向け）

- **小規模なLinux VPS** で常時稼働のGateway ゲートウェイを低コストで運用。[VPSホスティング](/vps)を参照。
- **専用ハードウェア**（Mac miniまたはLinuxマシン）: 完全なコントロールとブラウザ自動化向けの**住宅用IP**が欲しい場合。多くのサイトはデータセンターIPをブロックするため、ローカルでのブラウジングの方が動作しやすい場合があります。
- **ハイブリッド**: Gateway ゲートウェイを安価なVPSに置き、ブラウザ/UI自動化が必要な場合はMacを**ノード**として接続。[ノード](/nodes)と[Gatewayリモート](/gateway/remote)を参照。

macOS VMは、macOSのみの機能（iMessage/BlueBubbles）が必要な場合や、日常使いのMacから厳密に分離したい場合に使用してください。

## macOS VMオプション

### Apple Silicon Mac上のローカルVM（Lume）

[Lume](https://cua.ai/docs/lume)を使用して、既存のApple Silicon Mac上でサンドボックス化されたmacOS VMでOpenClawを実行します。

これにより以下が得られます：

- 分離された完全なmacOS環境（ホストはクリーンに保たれる）
- BlueBubblesによるiMessageサポート（Linux/Windowsでは不可能）
- VMのクローンによる即座のリセット
- 追加のハードウェアやクラウドコストなし

### ホスト型Macプロバイダー（クラウド）

クラウドでmacOSが必要な場合は、ホスト型Macプロバイダーも使えます：

- [MacStadium](https://www.macstadium.com/)（ホスト型Mac）
- 他のホスト型Macベンダーも対応；VM + SSHのドキュメントに従ってください

macOS VMへのSSHアクセスを取得したら、以下のステップ6に進んでください。

---

## クイックパス（Lume、経験者向け）

1. Lumeをインストール
2. `lume create openclaw --os macos --ipsw latest`
3. セットアップアシスタントを完了し、リモートログイン（SSH）を有効化
4. `lume run openclaw --no-display`
5. SSHでログインし、OpenClawをインストール、チャネルを設定
6. 完了

---

## 必要なもの（Lume）

- Apple Silicon Mac（M1/M2/M3/M4）
- ホストにmacOS Sequoia以降
- VM1台あたり約60 GBの空きディスク容量
- 約20分

---

## 1) Lumeをインストール

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin`がPATHにない場合：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

確認：

```bash
lume --version
```

ドキュメント: [Lumeのインストール](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) macOS VMを作成

```bash
lume create openclaw --os macos --ipsw latest
```

macOSをダウンロードしてVMを作成します。VNCウィンドウが自動的に開きます。

注意: ダウンロードは接続速度によって時間がかかる場合があります。

---

## 3) セットアップアシスタントを完了

VNCウィンドウで：

1. 言語と地域を選択
2. Apple IDをスキップ（後でiMessageが必要な場合はサインイン）
3. ユーザーアカウントを作成（ユーザー名とパスワードを記録）
4. オプション機能をすべてスキップ

セットアップ完了後、SSHを有効化：

1. システム設定 → 一般 → 共有 を開く
2. 「リモートログイン」を有効化

---

## 4) VMのIPアドレスを確認

```bash
lume get openclaw
```

IPアドレス（通常`192.168.64.x`）を確認します。

---

## 5) VMにSSH接続

```bash
ssh youruser@192.168.64.X
```

`youruser`を作成したアカウントに、IPをVMのIPに置き換えてください。

---

## 6) OpenClawをインストール

VM内で：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

オンボーディングのプロンプトに従ってモデルプロバイダー（Anthropic、OpenAIなど）を設定します。

---

## 7) チャネルを設定

設定ファイルを編集：

```bash
nano ~/.openclaw/openclaw.json
```

チャネルを追加：

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
    telegram: {
      botToken: "YOUR_BOT_TOKEN",
    },
  },
}
```

次にWhatsAppにログイン（QRコードをスキャン）：

```bash
openclaw channels login
```

---

## 8) VMをヘッドレスで実行

VMを停止してディスプレイなしで再起動：

```bash
lume stop openclaw
lume run openclaw --no-display
```

VMはバックグラウンドで実行されます。OpenClawのデーモンがGateway ゲートウェイを稼働し続けます。

ステータスを確認：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## ボーナス: iMessage連携

これがmacOSで実行する最大のメリットです。[BlueBubbles](https://bluebubbles.app)を使用してOpenClawにiMessageを追加します。

VM内で：

1. bluebubbles.appからBlueBubblesをダウンロード
2. Apple IDでサインイン
3. Web APIを有効化してパスワードを設定
4. BlueBubblesのウェブフックをGateway ゲートウェイに向ける（例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

OpenClawの設定に追加：

```json5
{
  channels: {
    bluebubbles: {
      serverUrl: "http://localhost:1234",
      password: "your-api-password",
      webhookPath: "/bluebubbles-webhook",
    },
  },
}
```

Gateway ゲートウェイを再起動します。これでエージェントがiMessageを送受信できるようになります。

詳細: [BlueBubblesチャネル](/channels/bluebubbles)

---

## ゴールデンイメージを保存

さらにカスタマイズする前に、クリーンな状態をスナップショット：

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

## 24時間稼働

VMを常時稼働させるには：

- Macを電源に接続したままにする
- システム設定 → エネルギー節約でスリープを無効化
- 必要に応じて`caffeinate`を使用

真の常時稼働には、専用のMac miniや小規模VPSを検討してください。[VPSホスティング](/vps)を参照。

---

## トラブルシューティング

| 問題                           | 解決方法                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| VMにSSH接続できない            | VMのシステム設定で「リモートログイン」が有効になっているか確認                        |
| VMのIPが表示されない           | VMが完全に起動するまで待ち、`lume get openclaw`を再実行                               |
| lumeコマンドが見つからない     | `~/.local/bin`をPATHに追加                                                            |
| WhatsAppのQRコードがスキャンできない | `openclaw channels login`実行時にホストではなくVMにログインしていることを確認        |

---

## 関連ドキュメント

- [VPSホスティング](/vps)
- [ノード](/nodes)
- [Gatewayリモート](/gateway/remote)
- [BlueBubblesチャネル](/channels/bluebubbles)
- [Lumeクイックスタート](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLIリファレンス](https://cua.ai/docs/lume/reference/cli-reference)
- [無人VMセットアップ](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（上級者向け）
- [Dockerサンドボックス化](/install/docker)（代替の分離アプローチ）
