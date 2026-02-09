---
summary: "受信した音声／ボイスノートがどのようにダウンロード、文字起こしされ、返信に注入されるか"
read_when:
  - 音声文字起こしやメディア処理を変更する場合
title: "音声とボイスノート"
---

# 音声／ボイスノート — 2026-01-17

## 動作するもの

- **メディア理解（音声）**: 音声理解が有効（または自動検出）な場合、OpenClaw は次を実行します。
  1. 最初の音声添付（ローカルパスまたは URL）を特定し、必要に応じてダウンロードします。
  2. 各モデルエントリーに送信する前に `maxBytes` を適用します。
  3. 順序どおりに最初の適格なモデルエントリー（プロバイダーまたは CLI）を実行します。
  4. 失敗またはスキップ（サイズ／タイムアウト）の場合、次のエントリーを試します。
  5. 成功すると、`Body` を `[Audio]` ブロックに置き換え、`{{Transcript}}` を設定します。
- **コマンド解析**: 文字起こしが成功すると、スラッシュコマンドが引き続き機能するように `CommandBody`/`RawBody` に文字起こし結果が設定されます。
- **詳細ログ**: `--verbose` では、文字起こしが実行されたタイミングと本文が置き換えられたタイミングをログに記録します。

## 自動検出（デフォルト）

**モデルを設定していない** かつ `tools.media.audio.enabled` が `false` に設定されて**いない**場合、
OpenClaw は次の順序で自動検出し、最初に動作したオプションで停止します。

1. **ローカル CLI**（インストールされている場合）
   - `sherpa-onnx-offline`（エンコーダ／デコーダ／ジョイナー／トークンを含む `SHERPA_ONNX_MODEL_DIR` が必要）
   - `whisper-cli`（`whisper-cpp` 由来。`WHISPER_CPP_MODEL` または同梱の tiny モデルを使用）
   - `whisper`（Python CLI。モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）を `read_many_files` で使用
3. **プロバイダーキー**（OpenAI → Groq → Deepgram → Google）

自動検出を無効にするには `tools.media.audio.enabled: false` を設定します。
カスタマイズするには `tools.media.audio.models` を設定します。
注記: バイナリ検出は macOS／Linux／Windows 全体でベストエフォートです。CLI が `PATH` 上にあること（`~` を展開します）を確認するか、完全なコマンドパスを指定した明示的な CLI モデルを設定してください。
カスタマイズするには、`tools.media.audio.models` を設定します。
注記: バイナリ検出は macOS／Linux／Windows 全体でベストエフォートです。CLI が `PATH` 上にあること（`~` を展開します）を確認するか、完全なコマンドパスを指定した明示的な CLI モデルを設定してください。

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

### スコープ制御付きプロバイダーのみ

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

## 注記と制限

- プロバイダー認証は、標準のモデル認証順（認証プロファイル、環境変数、`models.providers.*.apiKey`）に従います。
- `provider: "deepgram"` が使用されている場合、Deepgram は `DEEPGRAM_API_KEY` を取得します。
- Deepgram のセットアップ詳細: [Deepgram（音声文字起こし）](/providers/deepgram)。
- 音声プロバイダーは `tools.media.audio` を介して `baseUrl`、`headers`、`providerOptions` を上書きできます。
- デフォルトサイズのキャップは 20MB です(`tools.media.audio.maxBytes`)。 デフォルトのサイズ上限は 20MB（`tools.media.audio.maxBytes`）です。上限超過の音声はそのモデルではスキップされ、次のエントリーが試行されます。
- デフォルトの `maxChars` は**unset** (フルトランスクリプト) です。 音声のデフォルト `maxChars` は**未設定**（全文文字起こし）です。出力をトリミングするには `tools.media.audio.maxChars` またはエントリーごとの `maxChars` を設定してください。
- OpenAI の自動デフォルトは `gpt-4o-mini-transcribe` です。高精度が必要な場合は `model: "gpt-4o-transcribe"` を設定してください。
- 複数のボイスノートを処理するには `tools.media.audio.attachments` を使用します（`mode: "all"` + `maxAttachments`）。
- 文字起こし結果はテンプレートから `{{Transcript}}` として利用できます。
- CLI の stdout は上限（5MB）があります。CLI 出力は簡潔に保ってください。

## Gotchas

- スコープルールでは、最初の試合の勝利を使用します。 スコープルールは先頭一致が優先されます。`chatType` は `direct`、`group`、または `room` に正規化されます。
- CLI が終了コード 0 で終了し、プレーンテキストを出力することを確認してください。JSON は `jq -r .text` を介して整形する必要があります。
- 返信キューのブロックを避けるため、タイムアウト（`timeoutSeconds`、デフォルト 60 秒）は適切に設定してください。
