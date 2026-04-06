---
read_when:
    - APIプロバイダーが失敗した場合の信頼できるフォールバックが必要な場合
    - Claude Code CLIやその他のローカルAI CLIを実行しており、それらを再利用したい場合
    - セッションと画像をサポートしつつ、テキスト専用でツール不要のパスが必要な場合
summary: CLIバックエンド：ローカルAI CLIによるテキスト専用フォールバック
title: CLIバックエンド
x-i18n:
    generated_at: "2026-04-02T07:41:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6eec25cb6fd8416d00021f0ebcd548fee5f086b93ea36994735902e3fb865b9b
    source_path: gateway/cli-backends.md
    workflow: 15
---

# CLIバックエンド（フォールバックランタイム）

OpenClawは、APIプロバイダーがダウン、レート制限、または一時的に不調な場合に、**ローカルAI CLI**を**テキスト専用フォールバック**として実行できます。これは意図的に保守的な設計です：

- **ツールは無効**（ツール呼び出しなし）。
- **テキスト入力 → テキスト出力**（信頼性が高い）。
- **セッションをサポート**（フォローアップのターンが一貫性を保ちます）。
- **画像のパススルーが可能**（CLIが画像パスを受け付ける場合）。

これはプライマリパスではなく、**セーフティネット**として設計されています。外部APIに依存せず「常に動作する」テキスト応答が必要な場合に使用してください。

## 初心者向けクイックスタート

Claude Code CLIは**設定なしで**使用できます（バンドルされたAnthropicプラグインがデフォルトバックエンドを登録します）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLIもすぐに使えます（バンドルされたOpenAIプラグイン経由）：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.4
```

Gateway ゲートウェイがlaunchd/systemd配下で実行されていてPATHが最小限の場合、コマンドパスだけを追加してください：

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

これだけです。CLI自体以外にキーや追加の認証設定は不要です。

バンドルされたCLIバックエンドをGateway ゲートウェイホストの**プライマリメッセージプロバイダー**として使用する場合、設定がモデル参照または`agents.defaults.cliBackends`でそのバックエンドを明示的に参照していると、OpenClawは所有するバンドルプラグインを自動ロードするようになりました。

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

注意事項：

- `agents.defaults.models`（許可リスト）を使用する場合、`claude-cli/...`を含める必要があります。
- プライマリプロバイダーが失敗した場合（認証、レート制限、タイムアウト）、OpenClawは次にCLIバックエンドを試行します。

## 設定の概要

すべてのCLIバックエンドは以下の配下にあります：

```
agents.defaults.cliBackends
```

各エントリは**プロバイダーID**（例：`claude-cli`、`my-cli`）をキーとします。
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
            "claude-sonnet-4-6": "sonnet",
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

## 仕組み

1. プロバイダープレフィックス（`claude-cli/...`）に基づいて**バックエンドを選択**します。
2. 同じOpenClawプロンプト＋ワークスペースコンテキストを使用して**システムプロンプトを構築**します。
3. セッションID（サポートされている場合）を付けて**CLIを実行**し、履歴の一貫性を保ちます。
4. **出力を解析**（JSONまたはプレーンテキスト）し、最終テキストを返します。
5. バックエンドごとに**セッションIDを永続化**し、フォローアップで同じCLIセッションを再利用します。

## セッション

- CLIがセッションをサポートする場合、`sessionArg`（例：`--session-id`）を設定するか、IDを複数のフラグに挿入する必要がある場合は`sessionArgs`（プレースホルダー`{sessionId}`）を設定します。
- CLIが異なるフラグを持つ**resumeサブコマンド**を使用する場合、`resumeArgs`（再開時に`args`を置き換え）と、オプションで`resumeOutput`（非JSON再開用）を設定します。
- `sessionMode`：
  - `always`：常にセッションIDを送信（保存されていない場合は新しいUUID）。
  - `existing`：以前に保存されたセッションIDがある場合のみ送信。
  - `none`：セッションIDを送信しない。

## 画像（パススルー）

CLIが画像パスを受け付ける場合、`imageArg`を設定します：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClawはbase64画像を一時ファイルに書き出します。`imageArg`が設定されている場合、それらのパスはCLI引数として渡されます。`imageArg`が未設定の場合、OpenClawはファイルパスをプロンプトに追加します（パスインジェクション）。これは、プレーンパスからローカルファイルを自動読み込みするCLI（Claude Code CLIの動作）には十分です。

## 入力 / 出力

- `output: "json"`（デフォルト）はJSONを解析してテキスト＋セッションIDを抽出しようとします。
- `output: "jsonl"`はJSONLストリーム（Codex CLI `--json`）を解析し、最後のエージェントメッセージと存在する場合は`thread_id`を抽出します。
- `output: "text"`はstdoutを最終レスポンスとして扱います。

入力モード：

- `input: "arg"`（デフォルト）はプロンプトを最後のCLI引数として渡します。
- `input: "stdin"`はプロンプトをstdin経由で送信します。
- プロンプトが非常に長く`maxPromptArgChars`が設定されている場合、stdinが使用されます。

## デフォルト（プラグイン所有）

バンドルされたAnthropicプラグインは`claude-cli`のデフォルトを登録します：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

バンドルされたOpenAIプラグインも`codex-cli`のデフォルトを登録します：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","workspace-write","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","workspace-write","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

バンドルされたGoogleプラグインも`google-gemini-cli`のデフォルトを登録します：

- `command: "gemini"`
- `args: ["--prompt", "--output-format", "json"]`
- `resumeArgs: ["--resume", "{sessionId}", "--prompt", "--output-format", "json"]`
- `modelArg: "--model"`
- `sessionMode: "existing"`
- `sessionIdFields: ["session_id", "sessionId"]`

必要な場合のみオーバーライドしてください（一般的なケース：絶対`command`パス）。

## プラグイン所有のデフォルト

CLIバックエンドのデフォルトはプラグインサーフェスの一部になりました：

- プラグインは`api.registerCliBackend(...)`で登録します。
- バックエンドの`id`はモデル参照のプロバイダープレフィックスになります。
- `agents.defaults.cliBackends.<id>`のユーザー設定はプラグインのデフォルトをオーバーライドします。
- バックエンド固有の設定クリーンアップは、オプションの`normalizeConfig`フックを通じてプラグイン所有のままです。

## 制限事項

- **OpenClawツールなし**（CLIバックエンドはツール呼び出しを受け取りません）。一部のCLIは独自のエージェントツールを実行する場合があります。
- **ストリーミングなし**（CLI出力は収集後に返されます）。
- **構造化出力**はCLIのJSONフォーマットに依存します。
- **Codex CLIセッション**はテキスト出力で再開されます（JSONLではない）。そのため、初回の`--json`実行よりも構造化の程度が低くなります。OpenClawセッションは引き続き正常に動作します。

## トラブルシューティング

- **CLIが見つからない**：`command`をフルパスに設定してください。
- **モデル名が間違っている**：`modelAliases`を使用して`provider/model` → CLIモデルにマッピングしてください。
- **セッションの連続性がない**：`sessionArg`が設定されていて`sessionMode`が`none`ではないことを確認してください（Codex CLIは現在JSON出力での再開ができません）。
- **画像が無視される**：`imageArg`を設定してください（CLIがファイルパスをサポートしていることも確認してください）。
