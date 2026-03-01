---
summary: "インバウンドの音声/ボイスノートがダウンロード、文字起こし、返信に挿入される仕組み"
read_when:
  - 音声文字起こしやメディア処理を変更するとき
title: "音声とボイスノート"
---

# 音声 / ボイスノート — 2026-01-17

## 動作すること

- **メディア理解（音声）**: 音声理解が有効（または自動検出）になっている場合、OpenClaw は:
  1. 最初の音声添付ファイル（ローカルパスまたは URL）を見つけ、必要に応じてダウンロードします。
  2. 各モデルエントリに送信する前に `maxBytes` を適用します。
  3. 順番に最初の対象モデルエントリを実行します（プロバイダーまたは CLI）。
  4. 失敗またはスキップ（サイズ/タイムアウト）した場合、次のエントリを試します。
  5. 成功すると、`Body` を `[Audio]` ブロックに置き換えて `{{Transcript}}` を設定します。
- **コマンドパース**: 文字起こしが成功すると、スラッシュコマンドが引き続き動作するように `CommandBody`/`RawBody` がトランスクリプトに設定されます。
- **詳細ログ**: `--verbose` では、文字起こしが実行されたときとボディを置き換えたときをログに記録します。

## 自動検出（デフォルト）

モデルを**設定していない**場合かつ `tools.media.audio.enabled` が `false` に設定されていない場合、OpenClaw は以下の順序で自動検出し、最初に動作するオプションで停止します:

1. **ローカル CLI**（インストールされている場合）
   - `sherpa-onnx-offline`（`SHERPA_ONNX_MODEL_DIR` にエンコーダー/デコーダー/ジョイナー/トークンが必要）
   - `whisper-cli`（`whisper-cpp` から; `WHISPER_CPP_MODEL` またはバンドルされた tiny モデルを使用）
   - `whisper`（Python CLI; モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）`read_many_files` を使用
3. **プロバイダーキー**（OpenAI → Groq → Deepgram → Google）

自動検出を無効にするには `tools.media.audio.enabled: false` を設定してください。カスタマイズするには `tools.media.audio.models` を設定してください。注意: バイナリ検出は macOS/Linux/Windows でのベストエフォートです。CLI が `PATH` にあることを確認してください（`~` を展開します）。または完全なコマンドパスで明示的な CLI モデルを設定してください。

## 設定例

### プロバイダー + CLI フォールバック（OpenAI + Whisper CLI）

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

### スコープゲーティング付きプロバイダーのみ

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

## 注意事項と制限

- プロバイダー認証は標準のモデル認証順序に従います（認証プロファイル、環境変数、`models.providers.*.apiKey`）。
- `provider: "deepgram"` を使用する場合、Deepgram は `DEEPGRAM_API_KEY` を使用します。
- Deepgram の設定の詳細: [Deepgram（音声文字起こし）](/providers/deepgram)。
- Mistral の設定の詳細: [Mistral](/providers/mistral)。
- 音声プロバイダーは `tools.media.audio` を通じて `baseUrl`、`headers`、`providerOptions` をオーバーライドできます。
- デフォルトのサイズ上限は 20MB（`tools.media.audio.maxBytes`）です。サイズ超過の音声はそのモデルをスキップして次のエントリを試します。
- 音声のデフォルト `maxChars` は**未設定**（完全なトランスクリプト）です。出力を切り詰めるには `tools.media.audio.maxChars` またはエントリごとの `maxChars` を設定してください。
- OpenAI のデフォルトは `gpt-4o-mini-transcribe` です。より高い精度には `model: "gpt-4o-transcribe"` を設定してください。
- 複数のボイスノートを処理するには `tools.media.audio.attachments` を使用してください（`mode: "all"` + `maxAttachments`）。
- トランスクリプトはテンプレートで `{{Transcript}}` として使用できます。
- CLI の標準出力は制限されています（5MB）。CLI の出力を簡潔に保ってください。

## グループでのメンション検出

グループチャットで `requireMention: true` が設定されている場合、OpenClaw はメンションチェック**前**に音声を文字起こしします。これによりボイスノートにメンションが含まれていても処理できます。

**動作の仕組み:**

1. ボイスメッセージにテキストボディがなく、グループがメンションを必要とする場合、OpenClaw は「プリフライト」文字起こしを実行します。
2. トランスクリプトのメンションパターン（例: `@BotName`、絵文字トリガー）をチェックします。
3. メンションが見つかった場合、メッセージは完全な返信パイプラインを経由します。
4. トランスクリプトはメンション検出に使用され、ボイスノートがメンションゲートを通過できます。

**フォールバック動作:**

- プリフライト中に文字起こしが失敗した場合（タイムアウト、API エラーなど）、メッセージはテキストのみのメンション検出に基づいて処理されます。
- これにより、混合メッセージ（テキスト + 音声）が誤ってドロップされないことを保証します。

**例:** ユーザーが「Hey @Claude, what's the weather?」と言うボイスノートを `requireMention: true` の Telegram グループで送信した場合。ボイスノートが文字起こしされ、メンションが検出されて、エージェントが返信します。

## 注意点

- スコープルールは先着順で適用されます。`chatType` は `direct`、`group`、または `room` に正規化されます。
- CLI が 0 で終了してプレーンテキストを出力することを確認してください。JSON は `jq -r .text` で変換が必要です。
- 返信キューのブロックを避けるため、タイムアウトを適切に設定してください（`timeoutSeconds`、デフォルト 60 秒）。
- プリフライト文字起こしはメンション検出のために**最初の**音声添付ファイルのみを処理します。追加の音声はメインのメディア理解フェーズで処理されます。
