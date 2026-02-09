---
summary: "隔離や iMessage が必要な場合に、サンドボックス化された macOS VM（ローカルまたはホスト型）で OpenClaw を実行します"
read_when:
  - メインの macOS 環境から OpenClaw を隔離したい
  - サンドボックス内で iMessage 連携（BlueBubbles）を使いたい
  - クローン可能でリセットできる macOS 環境が欲しい
  - ローカルとホスト型の macOS VM オプションを比較したい
title: "macOS VM"
---

# macOS VM 上の OpenClaw（サンドボックス化）

## 推奨デフォルト（大多数のユーザー向け）

- **小規模な Linux VPS**：常時稼働の Gateway（ゲートウェイ）と低コストを実現します。[VPS hosting](/vps) を参照してください。 [VPSホスティング](/vps)を参照してください。
- **専用ハードウェア**（Mac mini または Linux マシン）：完全な制御と、ブラウザ自動化向けの **住宅用 IP** が必要な場合に適しています。多くのサイトはデータセンター IP をブロックするため、ローカルでのブラウジングの方がうまくいくことが多いです。 多くのサイトでデータセンターの IP をブロックするため、ローカルブラウジングはしばしばより良い動作します。
- **ハイブリッド**：安価な VPS に Gateway（ゲートウェイ）を置き、ブラウザ／UI 自動化が必要なときだけ Mac を **node** として接続します。[Nodes](/nodes) と [Gateway remote](/gateway/remote) を参照してください。 [Nodes](/nodes) と [Gateway remote](/gateway/remote) を参照してください。

macOS 専用の機能（iMessage / BlueBubbles）が必要な場合や、日常利用の Mac から厳密に隔離したい場合に、macOS VM を使用してください。

## macOS VM の選択肢

### Apple Silicon Mac 上のローカル VM（Lume）

既存の Apple Silicon Mac 上で、[Lume](https://cua.ai/docs/lume) を使用してサンドボックス化された macOS VM 内で OpenClaw を実行します。

これにより次が得られます：

- 隔離された完全な macOS 環境（ホストはクリーンなまま）
- BlueBubbles による iMessage サポート（Linux / Windows では不可能）
- VM のクローンによる即時リセット
- 追加のハードウェアやクラウド費用が不要

### ホスト型 Mac プロバイダー（クラウド）

クラウド上の macOS が必要な場合は、ホスト型 Mac プロバイダーも利用できます：

- [MacStadium](https://www.macstadium.com/)（ホスト型 Mac）
- その他のホスト型 Mac ベンダーも利用可能です。各社の VM + SSH ドキュメントに従ってください。

macOS VM への SSH アクセスが得られたら、以下の手順 6 に進んでください。

---

## クイックパス（Lume、経験者向け）

1. Lume をインストール
2. `lume create openclaw --os macos --ipsw latest`
3. セットアップアシスタントを完了し、リモートログイン（SSH）を有効化
4. `lume run openclaw --no-display`
5. SSH で接続し、OpenClaw をインストールしてチャンネルを設定
6. 完了

---

## 必要なもの（Lume）

- Apple Silicon Mac（M1 / M2 / M3 / M4）
- ホストに macOS Sequoia 以降
- VM あたり約 60 GB の空きディスク容量
- 約 20 分

---

## 1. Lume をインストール

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin` が PATH にない場合：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

確認：

```bash
lume --version
```

ドキュメント：[Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. macOS VM を作成

```bash
lume create openclaw --os macos --ipsw latest
```

これにより macOS がダウンロードされ、VM が作成されます。VNC ウィンドウが自動的に開きます。 VNC ウィンドウが自動的に開きます。

注記：ダウンロード時間は接続状況によっては長くなる場合があります。

---

## 3. セットアップアシスタントを完了

VNC ウィンドウで：

1. 言語と地域を選択
2. Apple ID をスキップ（後で iMessage を使う場合はサインインしても構いません）
3. ユーザーアカウントを作成（ユーザー名とパスワードを控えてください）
4. すべての任意機能をスキップ

セットアップ完了後、SSH を有効化します：

1. システム設定 → 一般 → 共有 を開く
2. 「リモートログイン」を有効化

---

## 4. VM の IP アドレスを取得

```bash
lume get openclaw
```

IP アドレス（通常は `192.168.64.x`）を確認します。

---

## 5. VM に SSH 接続

```bash
ssh youruser@192.168.64.X
```

`youruser` を作成したアカウント名に置き換え、IP は VM の IP に置き換えてください。

---

## 6. OpenClaw をインストール

VM 内で：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

オンボーディングの案内に従い、モデルプロバイダー（Anthropic、OpenAI など）を設定します。

---

## 7. チャンネルを設定

設定ファイルを編集します：

```bash
nano ~/.openclaw/openclaw.json
```

チャンネルを追加します：

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

次に WhatsApp にログインします（QR をスキャン）：

```bash
openclaw channels login
```

---

## 8. VM をヘッドレスで実行

VM を停止し、表示なしで再起動します：

```bash
lume stop openclaw
lume run openclaw --no-display
```

VMはバックグラウンドで実行されます。 VM はバックグラウンドで実行されます。OpenClaw のデーモンが Gateway（ゲートウェイ）を稼働させ続けます。

ステータスを確認するには：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 追加：iMessage 連携

これはmacOS上で実行するというキラーな機能です。 これは macOS で実行する際のキラーフィーチャーです。[BlueBubbles](https://bluebubbles.app) を使用して OpenClaw に iMessage を追加します。

VM 内で：

1. bluebubbles.app から BlueBubbles をダウンロード
2. Apple ID でサインイン
3. Web API を有効化し、パスワードを設定
4. BlueBubbles の Webhook を Gateway（ゲートウェイ）に向ける（例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

OpenClaw の設定に追加します：

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

ゲートウェイを再起動します。 Gateway（ゲートウェイ）を再起動します。これでエージェントが iMessage を送受信できるようになります。

詳細な設定手順：[BlueBubbles channel](/channels/bluebubbles)

---

## ゴールデンイメージを保存

さらにカスタマイズする前に、クリーンな状態をスナップショットします：

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

いつでもリセットできます：

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 での運用

VM を継続稼働させるには：

- Mac を電源に接続したままにする
- システム設定 → エネルギーでスリープを無効化
- 必要に応じて `caffeinate` を使用

真の常時稼働が必要な場合は、専用の Mac mini または小規模な VPS を検討してください。[VPS hosting](/vps) を参照してください。 [VPSホスティング](/vps)を参照してください。

---

## トラブルシューティング

| 問題                    | 解決策                                                              |
| --------------------- | ---------------------------------------------------------------- |
| VM に SSH 接続できない       | VM のシステム設定で「リモートログイン」が有効になっていることを確認してください                        |
| VM の IP が表示されない       | VM が完全に起動するまで待ち、`lume get openclaw` を再度実行してください                  |
| Lume コマンドが見つからない      | `~/.local/bin` を PATH に追加してください                                  |
| WhatsApp の QR が読み取れない | `openclaw channels login` を実行する際、ホストではなく VM にログインしていることを確認してください |

---

## 関連ドキュメント

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（高度）
- [Docker Sandboxing](/install/docker)（代替の隔離アプローチ）
