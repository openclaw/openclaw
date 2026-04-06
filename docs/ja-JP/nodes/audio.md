---
read_when:
    - 音声の文字起こしやメディア処理を変更する場合
summary: 受信した音声・ボイスメモのダウンロード、文字起こし、返信への挿入の仕組み
title: 音声とボイスメモ
x-i18n:
    generated_at: "2026-04-02T07:46:08Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7e85e5a3f0b586032752b1bf11955bf768d347c2b7c2d15b18162ea78c116c30
    source_path: nodes/audio.md
    workflow: 15
---

# 音声 / ボイスメモ (2026-01-17)

## 動作する機能

- **メディア理解（音声）**: 音声理解が有効（または自動検出）の場合、OpenClawは以下を行います:
  1. 最初の音声添付ファイル（ローカルパスまたはURL）を探し、必要に応じてダウンロードします。
  2. 各モデルエントリに送信する前に `maxBytes` を適用します。
  3. 最初に適格なモデルエントリを順番に実行します（プロバイダーまたはCLI）。
  4. 失敗またはスキップ（サイズ/タイムアウト）した場合、次のエントリを試行します。
  5. 成功すると、`Body` を `[Audio]` ブロックに置き換え、`{{Transcript}}` を設定します。
- **コマンド解析**: 文字起こしが成功すると、`CommandBody`/`RawBody` がトランスクリプトに設定されるため、スラッシュコマンドは引き続き動作します。
- **詳細ログ**: `--verbose` では、文字起こしの実行時とボディの置き換え時にログを出力します。

## 自動検出（デフォルト）

モデルを**設定せず**、`tools.media.audio.enabled` が `false` に設定されて**いない**場合、
OpenClawは以下の順序で自動検出し、最初に動作するオプションで停止します:

1. **ローカルCLI**（インストール済みの場合）
   - `sherpa-onnx-offline`（encoder/decoder/joiner/tokens を含む `SHERPA_ONNX_MODEL_DIR` が必要）
   - `whisper-cli`（`whisper-cpp` に同梱。`WHISPER_CPP_MODEL` またはバンドルされたtinyモデルを使用）
   - `whisper`（Python CLI。モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）`read_many_files` を使用
3. **プロバイダーキー**（OpenAI → Groq → Deepgram → Google）

自動検出を無効にするには、`tools.media.audio.enabled: false` を設定してください。
カスタマイズするには、`tools.media.audio.models` を設定してください。
注意: バイナリの検出はmacOS/Linux/Windowsでベストエフォートです。CLIが `PATH` 上にあることを確認するか（`~` は展開されます）、フルコマンドパスを指定した明示的なCLIモデルを設定してください。

## 設定例

### プロバイダー + CLIフォールバック（OpenAI + Whisper CLI）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### プロバイダーのみ（スコープゲーティング付き）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### プロバイダーのみ（Deepgram）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

### プロバイダーのみ（Mistral Voxtral）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

### トランスクリプトをチャットにエコー（オプトイン）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        echoTranscript: true, // default is false
        echoFormat: '📝 "{transcript}"', // optional, supports {transcript}
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

## 注意事項と制限

- プロバイダー認証は標準のモデル認証順序に従います（認証プロファイル、環境変数、`models.providers.*.apiKey`）。
- `provider: "deepgram"` を使用する場合、Deepgramは `DEEPGRAM_API_KEY` を参照します。
- Deepgramのセットアップ詳細: [Deepgram（音声文字起こし）](/providers/deepgram)。
- Mistralのセットアップ詳細: [Mistral](/providers/mistral)。
- 音声プロバイダーは `tools.media.audio` で `baseUrl`、`headers`、`providerOptions` をオーバーライドできます。
- デフォルトのサイズ上限は20MB（`tools.media.audio.maxBytes`）です。サイズ超過の音声はそのモデルでスキップされ、次のエントリが試行されます。
- 1024バイト未満の極小・空の音声ファイルは、プロバイダー/CLIの文字起こし前にスキップされます。
- 音声のデフォルト `maxChars` は**未設定**（完全なトランスクリプト）です。出力をトリミングするには、`tools.media.audio.maxChars` またはエントリごとの `maxChars` を設定してください。
- OpenAIの自動デフォルトは `gpt-4o-mini-transcribe` です。より高い精度には `model: "gpt-4o-transcribe"` を設定してください。
- `tools.media.audio.attachments` を使用して複数のボイスメモを処理できます（`mode: "all"` + `maxAttachments`）。
- トランスクリプトはテンプレートで `{{Transcript}}` として利用できます。
- `tools.media.audio.echoTranscript` はデフォルトでオフです。エージェント処理前に元のチャットにトランスクリプト確認を送信するには有効にしてください。
- `tools.media.audio.echoFormat` はエコーテキストをカスタマイズします（プレースホルダー: `{transcript}`）。
- CLIのstdoutは上限があります（5MB）。CLI出力は簡潔にしてください。

### プロキシ環境のサポート

プロバイダーベースの音声文字起こしは、標準のアウトバウンドプロキシ環境変数を参照します:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

プロキシ環境変数が設定されていない場合、直接接続が使用されます。プロキシ設定が不正な場合、OpenClawは警告をログに出力し、直接フェッチにフォールバックします。

## グループでのメンション検出

グループチャットで `requireMention: true` が設定されている場合、OpenClawはメンションのチェック**前に**音声を文字起こしします。これにより、メンションを含むボイスメモも処理できるようになります。

**動作の仕組み:**

1. ボイスメッセージにテキストボディがなく、グループがメンションを要求する場合、OpenClawは「プリフライト」文字起こしを実行します。
2. トランスクリプトはメンションパターン（例: `@BotName`、絵文字トリガー）でチェックされます。
3. メンションが見つかった場合、メッセージは完全な返信パイプラインに進みます。
4. トランスクリプトはメンション検出に使用されるため、ボイスメモがメンションゲートを通過できます。

**フォールバック動作:**

- プリフライト中に文字起こしが失敗した場合（タイムアウト、APIエラーなど）、メッセージはテキストのみのメンション検出に基づいて処理されます。
- これにより、混合メッセージ（テキスト + 音声）が誤って破棄されることはありません。

**Telegramグループ/トピックごとのオプトアウト:**

- そのグループでプリフライトのトランスクリプトメンションチェックをスキップするには、`channels.telegram.groups.<chatId>.disableAudioPreflight: true` を設定してください。
- トピックごとにオーバーライドするには、`channels.telegram.groups.<chatId>.topics.<threadId>.disableAudioPreflight` を設定してください（`true` でスキップ、`false` で強制有効）。
- デフォルトは `false`（メンションゲート条件に一致する場合、プリフライトが有効）です。

**例:** ユーザーが `requireMention: true` のTelegramグループで「Hey @Claude, what's the weather?」というボイスメモを送信します。ボイスメモが文字起こしされ、メンションが検出され、エージェントが返信します。

## 注意点

- スコープルールはファーストマッチ方式です。`chatType` は `direct`、`group`、または `room` に正規化されます。
- CLIが終了コード0で終了し、プレーンテキストを出力することを確認してください。JSONの場合は `jq -r .text` で変換する必要があります。
- `parakeet-mlx` の場合、`--output-dir` を指定すると、`--output-format` が `txt`（または省略）の場合にOpenClawは `<output-dir>/<media-basename>.txt` を読み取ります。`txt` 以外の出力フォーマットはstdout解析にフォールバックします。
- 返信キューのブロックを避けるため、タイムアウトは適切な値に設定してください（`timeoutSeconds`、デフォルト60秒）。
- プリフライト文字起こしはメンション検出のために**最初の**音声添付ファイルのみを処理します。追加の音声はメインのメディア理解フェーズで処理されます。
