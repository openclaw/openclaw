---
summary: "初心者向けガイド: ゼロから最初のメッセージ送信まで (ウィザード、認証、チャネル、ペアリング)"
read_when:
  - はじめてゼロからセットアップするとき
  - インストール → オンボーディング → 最初のメッセージまでを最短で進めたいとき
title: "Getting Started"
---

# Getting Started

目標: **ゼロ** から **最初に動くチャット** (無理のないデフォルト設定) までを、できるだけ素早く到達することです。

最速でチャットを始めるには: Control UI を開きます (チャネル設定は不要です)。`openclaw dashboard` を実行してブラウザでチャットするか、Gateway ホストで `http://127.0.0.1:18789/` を開いてください。
ドキュメント: [Dashboard](/web/dashboard) と [Control UI](/web/control-ui)。

推奨ルート: **CLI オンボーディングウィザード** (`openclaw onboard`) を使います。次をセットアップします:

- モデル/認証 (OAuth 推奨)
- Gateway 設定
- チャネル (WhatsApp/Telegram/Discord/Mattermost (plugin)/...)
- ペアリングのデフォルト (安全な DM)
- ワークスペース初期化 + Skills
- 任意のバックグラウンドサービス

より詳しいリファレンスを見たい場合は、こちらへ: [Wizard](/start/wizard)、[Setup](/start/setup)、[Pairing](/start/pairing)、[Security](/gateway/security)。

サンドボックスに関する注記: `agents.defaults.sandbox.mode: "non-main"` は `session.mainKey` (デフォルトは `"main"`) を使うため、グループ/チャネルのセッションはサンドボックス化されます。メインエージェントを常にホスト上で実行したい場合は、エージェント単位で明示的に上書きしてください:

```json
{
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    }
  }
}
```

## 0) 前提条件

- Node `>=22`
- `pnpm` (任意。ソースからビルドする場合は推奨)
- **推奨:** Web 検索用の Brave Search API キー。最も簡単な手順:
  `openclaw configure --section web` (`tools.web.search.apiKey` に保存されます)。
  [Web tools](/tools/web) を参照してください。

macOS: アプリをビルドする予定がある場合は Xcode / CLT をインストールしてください。CLI + Gateway のみであれば Node だけで十分です。
Windows: **WSL2** (Ubuntu 推奨) を使ってください。WSL2 を強く推奨します。ネイティブ Windows は未検証で、問題が起きやすく、ツール互換性も低くなります。先に WSL2 を導入し、その後 WSL 内で Linux 向け手順を実行してください。[Windows (WSL2)](/platforms/windows) を参照してください。

## 1) CLI をインストール (推奨)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

インストーラーオプション (インストール方法、非対話実行、GitHub からの導入): [Install](/install)。

Windows (PowerShell):

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

代替 (グローバルインストール):

```bash
npm install -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## 2) オンボーディングウィザードを実行 (サービスもインストール)

```bash
openclaw onboard --install-daemon
```

選択する内容:

- **ローカル or リモート** Gateway
- **認証**: OpenAI Code (Codex) サブスクリプション (OAuth) または API キー。Anthropic は API キーを推奨します。`claude setup-token` も利用可能です。
- **プロバイダー**: WhatsApp QR ログイン、Telegram/Discord のボットトークン、Mattermost プラグイントークンなど。
- **デーモン**: バックグラウンドインストール (launchd/systemd。WSL2 は systemd)
  - **ランタイム**: Node (推奨。WhatsApp/Telegram では必須)。Bun は **非推奨**。
- **Gateway トークン**: ウィザードはデフォルトでトークンを生成し (loopback でも)、`gateway.auth.token` に保存します。

ウィザードのドキュメント: [Wizard](/start/wizard)

### 認証情報の保存先 (重要)

- **推奨の Anthropic 経路:** API キーを設定します (ウィザードはサービス実行用に保存できます)。Claude Code の認証情報を再利用したい場合は `claude setup-token` も利用できます。

- OAuth 資格情報 (legacy import): `~/.openclaw/credentials/oauth.json`
- 認証プロファイル (OAuth + API キー): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

ヘッドレス/サーバー向けのヒント: まず通常のマシンで OAuth を完了し、その後 `oauth.json` を Gateway ホストへコピーしてください。

## 3) Gateway を起動

オンボーディング中にサービスをインストールしていれば、Gateway はすでに起動しているはずです:

```bash
openclaw gateway status
```

手動起動 (フォアグラウンド):

```bash
openclaw gateway --port 18789 --verbose
```

Dashboard (ローカル loopback): `http://127.0.0.1:18789/`
トークンが設定されている場合は、Control UI 設定に貼り付けてください (`connect.params.auth.token` として保存されます)。

⚠️ **Bun に関する警告 (WhatsApp + Telegram):** Bun にはこれらの
チャネルで既知の問題があります。WhatsApp または Telegram を使う場合は、Gateway を **Node** で実行してください。

## 3.5) クイック検証 (2 分)

```bash
openclaw status
openclaw health
openclaw security audit --deep
```

## 4) 最初のチャット面をペアリングして接続

### WhatsApp (QR ログイン)

```bash
openclaw channels login
```

WhatsApp → 設定 → リンク済みデバイス からスキャンしてください。

WhatsApp ドキュメント: [WhatsApp](/channels/whatsapp)

### Telegram / Discord / その他

ウィザードでトークン/設定を書き込めます。手動で設定したい場合は、まず以下を参照してください:

- Telegram: [Telegram](/channels/telegram)
- Discord: [Discord](/channels/discord)
- Mattermost (plugin): [Mattermost](/channels/mattermost)

**Telegram DM のヒント:** 最初の DM にはペアリングコードが返ってきます。次の手順で承認しないと、ボットは応答しません。

## 5) DM の安全性 (ペアリング承認)

デフォルトの方針: 未知の DM には短いコードが返され、承認されるまでメッセージは処理されません。
最初の DM に返信がない場合は、ペアリングを承認してください:

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code>
```

ペアリングのドキュメント: [Pairing](/start/pairing)

## From source (開発)

OpenClaw 本体を開発する場合は、ソースから実行します:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 初回実行時に UI 依存関係を自動インストール
pnpm build
openclaw onboard --install-daemon
```

まだグローバルインストールしていない場合は、リポジトリ内で `pnpm openclaw ...` としてオンボーディングを実行できます。
`pnpm build` は A2UI アセットもバンドルします。必要に応じてこの工程だけを実行するなら `pnpm canvas:a2ui:bundle` を使ってください。

Gateway (このリポジトリから):

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 7) エンドツーエンド検証

新しいターミナルでテストメッセージを送信します:

```bash
openclaw message send --target +15555550123 --message "Hello from OpenClaw"
```

`openclaw health` に “no auth configured” と表示される場合は、ウィザードに戻って OAuth/API キー認証を設定してください。これがないとエージェントは応答できません。

ヒント: `openclaw status --all` は貼り付けやすい read-only のデバッグレポートとして最適です。
ヘルスプローブ: `openclaw health` (または `openclaw status --deep`) は、実行中の Gateway にヘルススナップショットを問い合わせます。

## 次のステップ (任意だが有用)

- macOS メニューバーアプリ + 音声ウェイク: [macOS app](/platforms/macos)
- iOS/Android ノード (Canvas/カメラ/音声): [Nodes](/nodes)
- リモートアクセス (SSH トンネル / Tailscale Serve): [Remote access](/gateway/remote) と [Tailscale](/gateway/tailscale)
- 常時稼働 / VPN 構成: [Remote access](/gateway/remote)、[exe.dev](/platforms/exe-dev)、[Hetzner](/platforms/hetzner)、[macOS remote](/platforms/mac/remote)
