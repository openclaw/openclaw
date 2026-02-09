---
summary: "CLI バックエンド：ローカル AI CLI によるテキスト専用のフォールバック"
read_when:
  - API プロバイダーが失敗した際の信頼できるフォールバックが必要な場合
  - Claude Code CLI やその他のローカル AI CLI を実行しており、それらを再利用したい場合
  - セッションや画像をサポートしつつ、テキスト専用・ツールなしの経路が必要な場合
title: "CLI バックエンド"
---

# CLI バックエンド（フォールバック実行環境）

OpenClaw は、API プロバイダーが停止、レート制限、または一時的に不調な場合に、**ローカル AI CLI** を **テキスト専用のフォールバック** として実行できます。これは意図的に保守的な設計です。 これは意図的に保守的です。

- **ツールは無効**（ツール呼び出しなし）。
- **テキスト入力 → テキスト出力**（信頼性重視）。
- **セッションをサポート**（後続のやり取りの一貫性を維持）。
- CLI が画像パスを受け付ける場合、**画像をそのまま渡す**ことができます。

これは主要経路ではなく **セーフティネット** として設計されています。外部 API に依存せず、「常に動作する」テキスト応答が必要な場合に使用してください。 23. 外部 API に依存せず、「常に動作する」テキスト応答が欲しい場合に使用してください。

## 初心者向けクイックスタート

Claude Code CLI は **設定なし** で使用できます（OpenClaw には組み込みのデフォルトが同梱されています）。

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI もそのまま動作します。

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Gateway が launchd / systemd 配下で動作し、PATH が最小の場合は、コマンドのパスのみを追加してください。

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

以上です。 以上です。キーや、CLI 自体以外の追加認証設定は不要です。

## フォールバックとして使用する

プライマリモデルが失敗した場合にのみ実行されるよう、フォールバックリストに CLI バックエンドを追加します。

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

注記：

- `agents.defaults.models`（許可リスト）を使用する場合は、`claude-cli/...` を含める必要があります。
- プライマリプロバイダーが失敗（認証、レート制限、タイムアウト）した場合、OpenClaw は次に CLI バックエンドを試行します。

## 設定の概要

すべての CLI バックエンドは次の配下にあります。

```
agents.defaults.cliBackends
```

各エントリーは **プロバイダー ID**（例：`claude-cli`、`my-cli`）でキー付けされます。プロバイダー ID は、モデル参照の左側になります。
プロバイダー ID がモデル refの左側になります:

```
<provider>/<model>
```

### 設定例

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## How it works

1. **バックエンドを選択**：プロバイダープレフィックス（`claude-cli/...`）に基づいて選択します。
2. **システムプロンプトを構築**：同じ OpenClaw プロンプトとワークスペースのコンテキストを使用します。
3. **CLI を実行**：対応している場合はセッション ID を付与し、履歴の一貫性を保ちます。
4. **出力を解析**：JSON またはプレーンテキストを解析し、最終テキストを返します。
5. **セッション ID を永続化**：バックエンドごとに保存し、後続のやり取りで同じ CLI セッションを再利用します。

## セッション

- CLI がセッションをサポートする場合は、`sessionArg`（例：`--session-id`）を設定するか、ID を複数のフラグに挿入する必要がある場合は `sessionArgs`（プレースホルダー：`{sessionId}`）を設定します。
- CLI が異なるフラグを使用する **再開サブコマンド** を持つ場合は、`resumeArgs`（再開時に `args` を置き換え）を設定し、必要に応じて `resumeOutput`（非 JSON の再開用）を設定します。
- `sessionMode`：
  - `always`：常にセッション ID を送信（保存済みがなければ新しい UUID）。
  - `existing`：以前に保存されている場合のみセッション ID を送信。
  - `none`：セッション ID を送信しない。

## 画像（パススルー）

CLI が画像パスを受け付ける場合は、`imageArg` を設定します。

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClawは一時ファイルにbase64イメージを書き込みます。 `imageArg` が設定されている場合、
パスは CLI args として渡されます。 OpenClaw は base64 画像を一時ファイルに書き出します。`imageArg` が設定されている場合、それらのパスが CLI 引数として渡されます。`imageArg` が未設定の場合、OpenClaw はファイルパスをプロンプトに追記します（パス注入）。これは、プレーンなパスからローカルファイルを自動読み込みする CLI（Claude Code CLI の挙動）では十分です。

## 入力 / 出力

- `output: "json"`（デフォルト）：JSON を解析し、テキストとセッション ID を抽出します。
- `output: "jsonl"`：JSONL ストリーム（Codex CLI の `--json`）を解析し、最後のエージェントメッセージと、存在する場合は `thread_id` を抽出します。
- `output: "text"`：stdout を最終レスポンスとして扱います。

入力モード：

- `input: "arg"`（デフォルト）：プロンプトを最後の CLI 引数として渡します。
- `input: "stdin"`：プロンプトを stdin 経由で送信します。
- プロンプトが非常に長く、`maxPromptArgChars` が設定されている場合は、stdin が使用されます。

## デフォルト（組み込み）

OpenClaw には `claude-cli` のデフォルトが同梱されています。

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw には `codex-cli` のデフォルトも同梱されています。

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

必要な場合のみ上書きしてください（一般的には絶対パスの `command`）。

## 制限事項

- **OpenClaw のツールなし**（CLI バックエンドはツール呼び出しを受け取りません）。一部の CLI は独自のエージェントツールを実行する場合があります。 一部の CLI
  はまだ独自のエージェントツールを実行する可能性があります。
- **ストリーミングなし**（CLI の出力を収集してから返します）。
- **構造化出力**は、CLI の JSON 形式に依存します。
- **Codex CLI のセッション**は、テキスト出力（JSONL なし）で再開されるため、初回の `--json` 実行より構造化が弱くなります。OpenClaw のセッション自体は通常どおり機能します。 OpenClawセッションは通常
  動作します。

## トラブルシューティング

- **CLI が見つからない**：`command` をフルパスに設定してください。
- **モデル名が不正**：`modelAliases` を使用して、`provider/model` → CLI モデルにマッピングしてください。
- **セッションが継続しない**：`sessionArg` が設定され、`sessionMode` が `none` でないことを確認してください（Codex CLI は現在、JSON 出力での再開に対応していません）。
- **画像が無視される**：`imageArg` を設定し、CLI がファイルパスをサポートしていることを確認してください。
