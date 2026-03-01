---
summary: "CLIバックエンド：ローカルAI CLI経由のテキスト限定フォールバック"
read_when:
  - You want a reliable fallback when API providers fail
  - You are running Claude Code CLI or other local AI CLIs and want to reuse them
  - You need a text-only, tool-free path that still supports sessions and images
title: "CLIバックエンド"
---

# CLIバックエンド（フォールバックランタイム）

OpenClawは、APIプロバイダーがダウン、レート制限、または一時的に不安定な場合に、**ローカルAI CLI**を**テキスト限定フォールバック**として実行できます。これは意図的に保守的です：

- **ツールは無効**（ツールコールなし）。
- **テキスト入力 → テキスト出力**（信頼性が高い）。
- **セッションがサポートされます**（フォローアップターンの一貫性を維持）。
- **画像はパススルー可能**（CLIが画像パスを受け入れる場合）。

これは主要なパスではなく、**セーフティネット**として設計されています。外部APIに依存せずに「常に動作する」テキストレスポンスが必要な場合に使用してください。

## 初心者向けクイックスタート

Claude Code CLIは**設定なし**で使用できます（OpenClawに組み込みのデフォルトが同梱されています）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLIもそのまま動作します：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Gatewayがlaunchd/systemdで実行されていてPATHが最小限の場合、コマンドパスだけを追加します：

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

以上です。CLI自体以外にキーや追加の認証設定は不要です。

## フォールバックとしての使用

CLIバックエンドをフォールバックリストに追加して、プライマリモデルが失敗した場合にのみ実行されるようにします：

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

注意：

- `agents.defaults.models`（許可リスト）を使用する場合、`claude-cli/...`を含める必要があります。
- プライマリプロバイダーが失敗した場合（認証、レート制限、タイムアウト）、OpenClawは次にCLIバックエンドを試行します。

## 設定概要

すべてのCLIバックエンドは以下に配置されます：

```
agents.defaults.cliBackends
```

各エントリは**プロバイダーID**（例：`claude-cli`、`my-cli`）でキーイングされます。
プロバイダーIDはモデル参照の左側になります：

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

## 動作の仕組み

1. プロバイダープレフィックス（`claude-cli/...`）に基づいて**バックエンドを選択**します。
2. 同じOpenClawプロンプト + ワークスペースコンテキストを使用して**システムプロンプトを構築**します。
3. セッションID（サポートされている場合）付きで**CLIを実行**し、履歴の一貫性を保ちます。
4. **出力を解析**（JSONまたはプレーンテキスト）し、最終テキストを返します。
5. バックエンドごとに**セッションIDを永続化**し、フォローアップが同じCLIセッションを再利用します。

## セッション

- CLIがセッションをサポートしている場合、`sessionArg`（例：`--session-id`）を設定するか、IDを複数のフラグに挿入する必要がある場合は`sessionArgs`（プレースホルダー`{sessionId}`）を設定します。
- CLIが異なるフラグを持つ**再開サブコマンド**を使用する場合、`resumeArgs`（再開時に`args`を置き換え）とオプションの`resumeOutput`（非JSON再開用）を設定します。
- `sessionMode`：
  - `always`：常にセッションIDを送信（保存されていない場合は新しいUUID）。
  - `existing`：以前に保存されたセッションIDがある場合のみ送信。
  - `none`：セッションIDを送信しない。

## 画像（パススルー）

CLIが画像パスを受け入れる場合、`imageArg`を設定します：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClawはbase64画像を一時ファイルに書き込みます。`imageArg`が設定されている場合、それらのパスはCLI引数として渡されます。`imageArg`がない場合、OpenClawはプロンプトにファイルパスを追加します（パスインジェクション）。これはプレーンパスからローカルファイルを自動ロードするCLI（Claude Code CLIの動作）には十分です。

## 入力/出力

- `output: "json"`（デフォルト）はJSONを解析し、テキスト + セッションIDを抽出しようとします。
- `output: "jsonl"`はJSONLストリーム（Codex CLI `--json`）を解析し、最後のエージェントメッセージと存在する場合の`thread_id`を抽出します。
- `output: "text"`はstdoutを最終レスポンスとして扱います。

入力モード：

- `input: "arg"`（デフォルト）はプロンプトを最後のCLI引数として渡します。
- `input: "stdin"`はプロンプトをstdin経由で送信します。
- プロンプトが非常に長く`maxPromptArgChars`が設定されている場合、stdinが使用されます。

## デフォルト（組み込み）

OpenClawには`claude-cli`のデフォルトが同梱されています：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClawには`codex-cli`のデフォルトも同梱されています：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

必要な場合のみオーバーライドしてください（一般的：絶対`command`パス）。

## 制限事項

- **OpenClawツールなし**（CLIバックエンドはツールコールを受け取りません）。一部のCLIは独自のエージェントツーリングを実行する場合があります。
- **ストリーミングなし**（CLI出力は収集されてから返されます）。
- **構造化出力**はCLIのJSONフォーマットに依存します。
- **Codex CLIセッション**はテキスト出力で再開されます（JSONLなし）。これは初回の`--json`実行よりも構造化されていません。OpenClawセッションは引き続き正常に動作します。

## トラブルシューティング

- **CLIが見つからない**：`command`をフルパスに設定してください。
- **モデル名が間違っている**：`modelAliases`を使用して`provider/model` → CLIモデルをマッピングしてください。
- **セッションの継続性がない**：`sessionArg`が設定され、`sessionMode`が`none`でないことを確認してください（Codex CLIは現在JSON出力で再開できません）。
- **画像が無視される**：`imageArg`を設定してください（CLIがファイルパスをサポートしていることを確認）。
