---
summary: "安全上の注意を含む、OpenClaw をパーソナルアシスタントとして実行するためのエンドツーエンドガイド"
read_when:
  - 新しいアシスタントインスタンスのオンボーディング時
  - 安全性／権限の影響を確認する際
title: "パーソナルアシスタントのセットアップ"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:26Z
---

# OpenClaw でパーソナルアシスタントを構築する

OpenClaw は **Pi** エージェント向けの WhatsApp + Telegram + Discord + iMessage ゲートウェイです。プラグインにより Mattermost が追加されます。本ガイドは「パーソナルアシスタント」構成を対象としています。つまり、常時稼働のエージェントとして振る舞う、専用の WhatsApp 番号を 1 つ用意する構成です。

## ⚠️ 安全第一

エージェントを次のような立場に置くことになります。

- （Pi のツール設定によっては）あなたのマシン上でコマンドを実行する
- ワークスペース内のファイルを読み書きする
- WhatsApp / Telegram / Discord / Mattermost（プラグイン）経由で外部にメッセージを送信する

最初は保守的に始めてください。

- 必ず `channels.whatsapp.allowFrom` を設定してください（個人用 Mac をインターネットに全面公開してはいけません）。
- アシスタント専用の WhatsApp 番号を使用してください。
- ハートビートは現在、既定で 30 分ごとです。セットアップを信頼できるようになるまでは、`agents.defaults.heartbeat.every: "0m"` を設定して無効化してください。

## 前提条件

- OpenClaw がインストール済みで、オンボーディングが完了していること（未実施の場合は [Getting Started](/start/getting-started) を参照）
- アシスタント用の第 2 の電話番号（SIM / eSIM / プリペイド）

## 2 台のスマートフォン構成（推奨）

目指す構成はこれです。

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

個人用の WhatsApp を OpenClaw にリンクすると、あなた宛てのすべてのメッセージが「エージェント入力」になります。これはほとんどの場合、望ましくありません。

## 5 分クイックスタート

1. WhatsApp Web をペアリングします（QR が表示されるので、アシスタント用のスマートフォンでスキャンします）。

```bash
openclaw channels login
```

2. Gateway（ゲートウェイ）を起動します（起動したままにします）。

```bash
openclaw gateway --port 18789
```

3. `~/.openclaw/openclaw.json` に最小構成の設定を置きます。

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

次に、許可リストに入っているあなたの電話から、アシスタントの番号にメッセージを送信してください。

オンボーディングが完了すると、ダッシュボードが自動で開き、クリーンな（トークンを含まない）リンクが表示されます。認証を求められた場合は、`gateway.auth.token` にあるトークンを Control UI の設定に貼り付けてください。後から再度開くには `openclaw dashboard` を使用します。

## エージェントにワークスペースを与える（AGENTS）

OpenClaw は、ワークスペースディレクトリから操作指示や「記憶」を読み込みます。

既定では、OpenClaw はエージェントのワークスペースとして `~/.openclaw/workspace` を使用し、セットアップ時または最初のエージェント実行時に自動で作成します（さらにスターターとして `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` も作成されます）。`BOOTSTRAP.md` は、ワークスペースが完全に新規の場合にのみ作成されます（削除後に再作成されるべきではありません）。`MEMORY.md` は任意（自動作成されません）で、存在する場合は通常セッションで読み込まれます。サブエージェントのセッションでは `AGENTS.md` と `TOOLS.md` のみが注入されます。

ヒント: このフォルダは OpenClaw の「記憶」として扱い、（理想的にはプライベートな）git リポジトリにしてください。そうすることで `AGENTS.md` とメモリファイルがバックアップされます。git がインストールされている場合、新規ワークスペースは自動で初期化されます。

```bash
openclaw setup
```

完全なワークスペース構成とバックアップガイド: [Agent workspace](/concepts/agent-workspace)  
メモリのワークフロー: [Memory](/concepts/memory)

任意: `agents.defaults.workspace` を使って別のワークスペースを指定できます（`~` をサポート）。

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

すでにリポジトリから独自のワークスペースファイルを配布している場合は、ブートストラップ用ファイルの作成を完全に無効化できます。

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## 「アシスタント」にするための設定

OpenClaw は既定で良好なアシスタント設定になっていますが、通常は次の点を調整したくなるでしょう。

- `SOUL.md` にあるペルソナ／指示
- 思考に関する既定値（必要に応じて）
- ハートビート（信頼できるようになったら）

例:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## セッションとメモリ

- セッションファイル: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- セッションメタデータ（トークン使用量、最後のルートなど）: `~/.openclaw/agents/<agentId>/sessions/sessions.json`（旧形式: `~/.openclaw/sessions/sessions.json`）
- `/new` または `/reset` を送信すると、そのチャットの新しいセッションが開始されます（`resetTriggers` で設定可能）。単独で送信した場合、リセット確認として短い挨拶が返されます。
- `/compact [instructions]` はセッションコンテキストを圧縮し、残りのコンテキスト予算を報告します。

## ハートビート（プロアクティブモード）

既定では、OpenClaw は次のプロンプトで 30 分ごとにハートビートを実行します。  
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`  
無効化するには `agents.defaults.heartbeat.every: "0m"` を設定します。

- `HEARTBEAT.md` が存在していても、実質的に空（空行と `# Heading` のような Markdown 見出しのみ）の場合、OpenClaw は API コールを節約するためハートビート実行をスキップします。
- ファイルが存在しない場合でも、ハートビートは実行され、モデルが何をするかを判断します。
- エージェントが `HEARTBEAT_OK`（必要に応じて短いパディング付き。`agents.defaults.heartbeat.ackMaxChars` を参照）で応答した場合、そのハートビートについては外部への送信が抑制されます。
- ハートビートは完全なエージェントターンとして実行されます。間隔を短くすると、より多くのトークンを消費します。

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## メディアの入出力

受信した添付ファイル（画像／音声／ドキュメント）は、テンプレートを使ってコマンドに渡せます。

- `{{MediaPath}}`（ローカルの一時ファイルパス）
- `{{MediaUrl}}`（疑似 URL）
- `{{Transcript}}`（音声文字起こしが有効な場合）

エージェントからの送信添付ファイルは、1 行単独（スペースなし）で `MEDIA:<path-or-url>` を含めてください。例:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw はこれらを抽出し、テキストと一緒にメディアとして送信します。

## 運用チェックリスト

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

ログは `/tmp/openclaw/` 配下に保存されます（既定: `openclaw-YYYY-MM-DD.log`）。

## 次のステップ

- WebChat: [WebChat](/web/webchat)
- Gateway 運用: [Gateway runbook](/gateway)
- Cron + 起動: [Cron jobs](/automation/cron-jobs)
- macOS メニューバーのコンパニオン: [OpenClaw macOS app](/platforms/macos)
- iOS ノードアプリ: [iOS app](/platforms/ios)
- Android ノードアプリ: [Android app](/platforms/android)
- Windows の状況: [Windows (WSL2)](/platforms/windows)
- Linux の状況: [Linux app](/platforms/linux)
- セキュリティ: [Security](/gateway/security)
