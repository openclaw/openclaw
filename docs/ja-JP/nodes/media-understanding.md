---
summary: "プロバイダー + CLI フォールバックを使用したインバウンド画像/音声/ビデオの理解（オプション）"
read_when:
  - メディア理解の設計またはリファクタリング
  - インバウンドの音声/ビデオ/画像の前処理のチューニング
title: "メディア理解"
---

# メディア理解（インバウンド）— 2026-01-17

OpenClaw は返信パイプラインが実行される前に**インバウンドメディア**（画像/音声/ビデオ）を**要約**できます。ローカルツールまたはプロバイダーキーが利用可能な場合に自動検出し、無効にしたりカスタマイズしたりできます。理解がオフの場合でも、モデルは通常通り元のファイル/URL を受け取ります。

## 目標

- オプション: より速いルーティングとより良いコマンドパースのためにインバウンドメディアを短いテキストに事前消化します。
- モデルへの元のメディアのデリバリーを保持します（常時）。
- **プロバイダー API** と **CLI フォールバック**をサポートします。
- 順序付きフォールバック（エラー/サイズ/タイムアウト）を持つ複数のモデルを許可します。

## 高レベルの動作

1. インバウンド添付ファイルを収集します（`MediaPaths`、`MediaUrls`、`MediaTypes`）。
2. 有効な各機能（画像/音声/ビデオ）について、ポリシーごとに添付ファイルを選択します（デフォルト: **最初**）。
3. 最初の対象モデルエントリを選択します（サイズ + 機能 + 認証）。
4. モデルが失敗またはメディアが大きすぎる場合、**次のエントリにフォールバックします**。
5. 成功時:
   - `Body` は `[Image]`、`[Audio]`、または `[Video]` ブロックになります。
   - 音声は `{{Transcript}}` を設定します。コマンドパースはキャプションテキストがある場合はそれを使用し、ない場合はトランスクリプトを使用します。
   - キャプションはブロック内の `User text:` として保持されます。

理解が失敗または無効の場合、**返信フローは元のボディ + 添付ファイルで続行**されます。

## 設定の概要

`tools.media` は**共有モデル**と機能ごとのオーバーライドをサポートします:

- `tools.media.models`: 共有モデルリスト（`capabilities` でゲーティング）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - デフォルト（`prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`）
  - プロバイダーオーバーライド（`baseUrl`、`headers`、`providerOptions`）
  - `tools.media.audio.providerOptions.deepgram` を通じた Deepgram 音声オプション
  - オプションの**機能ごとの `models` リスト**（共有モデルより優先）
  - `attachments` ポリシー（`mode`、`maxAttachments`、`prefer`）
  - `scope`（チャンネル/chatType/セッションキーによるオプションのゲーティング）
- `tools.media.concurrency`: 最大同時実行数（デフォルト **2**）。

```json5
{
  tools: {
    media: {
      models: [
        /* 共有リスト */
      ],
      image: {
        /* オプションのオーバーライド */
      },
      audio: {
        /* オプションのオーバーライド */
      },
      video: {
        /* オプションのオーバーライド */
      },
    },
  },
}
```

### モデルエントリ

各 `models[]` エントリは**プロバイダー**または **CLI** にできます:

```json5
{
  type: "provider", // 省略した場合のデフォルト
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // オプション、マルチモーダルエントリに使用
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI テンプレートでは以下も使用できます:

- `{{MediaDir}}`（メディアファイルを含むディレクトリ）
- `{{OutputDir}}`（この実行用に作成されたスクラッチディレクトリ）
- `{{OutputBase}}`（スクラッチファイルのベースパス、拡張子なし）

## デフォルトと制限

推奨デフォルト:

- `maxChars`: 画像/ビデオは **500**（短く、コマンドに適した形式）
- `maxChars`: 音声は**未設定**（制限を設定しない限り完全なトランスクリプト）
- `maxBytes`:
  - 画像: **10MB**
  - 音声: **20MB**
  - ビデオ: **50MB**

ルール:

- メディアが `maxBytes` を超えた場合、そのモデルをスキップして**次のモデルを試みます**。
- モデルが `maxChars` より多く返した場合、出力は切り詰められます。
- `prompt` のデフォルトは「{media} を説明してください。」に `maxChars` ガイダンスを加えたものです（画像/ビデオのみ）。
- `<capability>.enabled: true` だがモデルが設定されていない場合、OpenClaw はプロバイダーが機能をサポートしている場合に**アクティブな返信モデル**を試みます。

### メディア理解の自動検出（デフォルト）

`tools.media.<capability>.enabled` が `false` に設定されておらずモデルを設定していない場合、OpenClaw は以下の順序で自動検出し、**最初に動作するオプションで停止**します:

1. **ローカル CLI**（音声のみ; インストールされている場合）
   - `sherpa-onnx-offline`（`SHERPA_ONNX_MODEL_DIR` にエンコーダー/デコーダー/ジョイナー/トークンが必要）
   - `whisper-cli`（`whisper-cpp`; `WHISPER_CPP_MODEL` またはバンドルされた tiny モデルを使用）
   - `whisper`（Python CLI; モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）`read_many_files` を使用
3. **プロバイダーキー**
   - 音声: OpenAI → Groq → Deepgram → Google
   - 画像: OpenAI → Anthropic → Google → MiniMax
   - ビデオ: Google

自動検出を無効にするには以下を設定してください:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

注意: バイナリ検出は macOS/Linux/Windows でのベストエフォートです。CLI が `PATH` にあることを確認してください（`~` を展開します）。または完全なコマンドパスで明示的な CLI モデルを設定してください。

## 機能（オプション）

`capabilities` を設定した場合、エントリはそれらのメディアタイプに対してのみ実行されます。共有リストの場合、OpenClaw はデフォルトを推測できます:

- `openai`、`anthropic`、`minimax`: **画像**
- `google`（Gemini API）: **画像 + 音声 + ビデオ**
- `groq`: **音声**
- `deepgram`: **音声**

CLI エントリの場合、予期しない一致を避けるために **`capabilities` を明示的に設定してください**。`capabilities` を省略した場合、エントリはそれが表示されるリストに対して対象となります。

## プロバイダーサポートマトリックス（OpenClaw 統合）

| 機能   | プロバイダー統合                                           | 注意                                                          |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------- |
| 画像   | OpenAI / Anthropic / Google / `pi-ai` 経由のその他        | レジストリ内の画像対応モデルは何でも動作します。              |
| 音声   | OpenAI、Groq、Deepgram、Google、Mistral                    | プロバイダーの文字起こし（Whisper/Deepgram/Gemini/Voxtral）。 |
| ビデオ | Google（Gemini API）                                       | プロバイダーのビデオ理解。                                    |

## 推奨プロバイダー

**画像**

- アクティブモデルが画像をサポートしている場合はそれを優先します。
- 良いデフォルト: `openai/gpt-5.2`、`anthropic/claude-opus-4-6`、`google/gemini-3-pro-preview`。

**音声**

- `openai/gpt-4o-mini-transcribe`、`groq/whisper-large-v3-turbo`、`deepgram/nova-3`、または `mistral/voxtral-mini-latest`。
- CLI フォールバック: `whisper-cli`（whisper-cpp）または `whisper`。
- Deepgram の設定: [Deepgram（音声文字起こし）](/providers/deepgram)。

**ビデオ**

- `google/gemini-3-flash-preview`（高速）、`google/gemini-3-pro-preview`（より豊富）。
- CLI フォールバック: `gemini` CLI（ビデオ/音声で `read_file` をサポート）。

## 添付ファイルポリシー

機能ごとの `attachments` は処理される添付ファイルを制御します:

- `mode`: `first`（デフォルト）または `all`
- `maxAttachments`: 処理数の上限（デフォルト **1**）
- `prefer`: `first`、`last`、`path`、`url`

`mode: "all"` の場合、出力は `[Image 1/2]`、`[Audio 2/2]` などとラベル付けされます。

## 設定例

### 1) 共有モデルリスト + オーバーライド

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2) 音声 + ビデオのみ（画像はオフ）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3) オプションの画像理解

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4) マルチモーダル単一エントリ（明示的な機能）

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## ステータス出力

メディア理解が実行されると、`/status` には短いサマリー行が含まれます:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

これは機能ごとの結果と、該当する場合に選択されたプロバイダー/モデルを示します。

## 注意

- 理解は**ベストエフォート**です。エラーは返信をブロックしません。
- 理解が無効でも添付ファイルはモデルに渡されます。
- `scope` を使用して理解が実行される場所を制限します（例: DM のみ）。

## 関連ドキュメント

- [設定](/gateway/configuration)
- [画像とメディアのサポート](/nodes/images)
