---
summary: "プロバイダー + CLI フォールバックによる受信画像／音声／動画の理解（オプション）"
read_when:
  - メディア理解の設計またはリファクタリング時
  - 受信音声／動画／画像の前処理を調整する場合
title: "メディア理解"
---

# メディア理解（受信）— 2026-01-17

OpenClawは返信パイプラインが実行される前に**インバウンドメディア**（画像/オーディオ/ビデオ）をまとめることができます。 ローカルツールまたはプロバイダキーが利用可能な場合に自動検出され、無効化またはカスタマイズが可能です。 理解がオフの場合、モデルは通常どおり元のファイル/URLを受け取ります。

## 目標

- オプション: 受信メディアを短いテキストに事前要約し、ルーティングの高速化とコマンド解析の精度向上を図る。
- 元のメディア配信をモデルに対して常に保持する。
- **プロバイダー API** と **CLI フォールバック** をサポートする。
- エラー／サイズ／タイムアウト時の順序付きフォールバックを伴う複数モデルを許可する。

## 高レベルの挙動

1. 受信添付ファイルを収集する（`MediaPaths`、`MediaUrls`、`MediaTypes`）。
2. 有効な各ケイパビリティ（画像／音声／動画）について、ポリシーに従って添付を選択する（デフォルト: **最初**）。
3. 適格な最初のモデルエントリーを選択する（サイズ + ケイパビリティ + 認証）。
4. モデルが失敗する、またはメディアが大きすぎる場合、**次のエントリーにフォールバック**する。
5. 成功時:
   - `Body` は `[Image]`、`[Audio]`、または `[Video]` ブロックになる。
   - 音声は `{{Transcript}}` を設定する。コマンド解析はキャプションが存在する場合はそのテキストを使用し、なければ文字起こしを使用する。
   - キャプションはブロック内の `User text:` として保持される。

理解が失敗した場合、または無効化されている場合でも、**返信フローは元の本文 + 添付** で継続されます。

## 設定の概要

`tools.media` は **共有モデル** とケイパビリティ別の上書きをサポートします。

- `tools.media.models`: 共有モデルリスト（`capabilities` を使用してゲート）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - デフォルト（`prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`）
  - プロバイダー上書き（`baseUrl`、`headers`、`providerOptions`）
  - `tools.media.audio.providerOptions.deepgram` による Deepgram 音声オプション
  - オプションの **ケイパビリティ別 `models` リスト**（共有モデルより優先）
  - `attachments` ポリシー（`mode`、`maxAttachments`、`prefer`）
  - `scope`（チャンネル／chatType／セッションキーによるオプションのゲーティング）
- `tools.media.concurrency`: 同時実行可能なケイパビリティの最大数（デフォルト **2**）。

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### モデルエントリー

各 `models[]` エントリーは **プロバイダー** または **CLI** にできます。

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
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

CLI テンプレートでは次も使用できます。

- `{{MediaDir}}`（メディアファイルを含むディレクトリ）
- `{{OutputDir}}`（この実行用に作成されるスクラッチディレクトリ）
- `{{OutputBase}}`（拡張子なしのスクラッチファイルのベースパス）

## デフォルトと制限

推奨デフォルト:

- `maxChars`: 画像／動画で **500**（短く、コマンド向け）
- `maxChars`: 音声は **未設定**（制限を設定しない限り全文文字起こし）
- `maxBytes`:
  - 画像: **10MB**
  - 音声: **20MB**
  - 動画: **50MB**

ルール:

- メディアが `maxBytes` を超える場合、そのモデルはスキップされ、**次のモデルが試行**されます。
- モデルの出力が `maxChars` を超えた場合、出力はトリミングされます。
- `prompt` は、シンプルな「Describe the {media}.」に `maxChars` のガイダンス（画像／動画のみ）を加えたものがデフォルトです。
- `<capability>.enabled: true` が有効で、かつモデルが設定されていない場合、OpenClaw は、そのプロバイダーが該当ケイパビリティをサポートしていれば **アクティブな返信モデル** を試します。

### メディア理解の自動検出（デフォルト）

`tools.media.<capability>.enabled` が `false` に設定されておらず、モデルを設定していない場合、OpenClaw は次の順序で自動検出し、**最初に動作したオプションで停止**します。

1. **ローカル CLI**（音声のみ；インストールされている場合）
   - `sherpa-onnx-offline`（エンコーダ／デコーダ／ジョイナー／トークンを備えた `SHERPA_ONNX_MODEL_DIR` が必要）
   - `whisper-cli`（`whisper-cpp`；`WHISPER_CPP_MODEL` または同梱の tiny モデルを使用）
   - `whisper`（Python CLI；モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）を `read_many_files` で使用
3. **プロバイダーキー**
   - 音声: OpenAI → Groq → Deepgram → Google
   - 画像: OpenAI → Anthropic → Google → MiniMax
   - 動画: Google

自動検出を無効にするには、次を設定します。

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

注記: バイナリ検出は macOS／Linux／Windows 全体でベストエフォートです。CLI が `PATH` 上にあること（`~` を展開します）を確認するか、完全なコマンドパスを指定した明示的な CLI モデルを設定してください。

## ケイパビリティ（オプション）

`capabilities`を設定すると、エントリはそれらのメディアタイプに対してのみ実行されます。
共有リストの場合、OpenClawはデフォルトを推測できます。

- `openai`、`anthropic`、`minimax`: **image**
- `google`（Gemini API）: **image + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

CLI のエントリでは、驚くべき一致を避けるために **明示的に `capabilities` を設定** します。
`capabilities`を省略した場合、エントリは表示されるリストの対象となります。

## プロバイダー対応マトリクス（OpenClaw 連携）

| Capability | Provider integration                         | Notes                              |
| ---------- | -------------------------------------------- | ---------------------------------- |
| Image      | OpenAI / Anthropic / Google / `pi-ai` 経由のその他 | レジストリ内の画像対応モデルであれば動作します。           |
| Audio      | OpenAI、Groq、Deepgram、Google                  | プロバイダの転記法（Whisper/Deepgram/Gemini） |
| Video      | Google（Gemini API）                           | プロバイダーによる動画理解。                     |

## 推奨プロバイダー

**画像**

- 画像をサポートしている場合は、アクティブなモデルを優先してください。
- 良いデフォルト: `openai/gpt-5.2`、`anthropic/claude-opus-4-6`、`google/gemini-3-pro-preview`。

**音声**

- `openai/gpt-4o-mini-transcribe`、`groq/whisper-large-v3-turbo`、または `deepgram/nova-3`。
- CLI フォールバック: `whisper-cli`（whisper-cpp）または `whisper`。
- Deepgram のセットアップ: [Deepgram（音声文字起こし）](/providers/deepgram)。

**動画**

- `google/gemini-3-flash-preview`（高速）、`google/gemini-3-pro-preview`（高機能）。
- CLI フォールバック: `gemini` CLI（動画／音声の `read_file` をサポート）。

## 添付ポリシー

ケイパビリティ別の `attachments` は、どの添付を処理するかを制御します。

- `mode`: `first`（デフォルト）または `all`
- `maxAttachments`: 処理する数の上限（デフォルト **1**）
- `prefer`: `first`、`last`、`path`、`url`

`mode: "all"` の場合、出力には `[Image 1/2]`、`[Audio 2/2]` などのラベルが付きます。

## 設定例

### 1. 共有モデルリスト + 上書き

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

### 2. 音声 + 動画のみ（画像オフ）

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

### 3. オプションの画像理解

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

### 4. マルチモーダル単一エントリー（明示的ケイパビリティ）

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

メディア理解が実行されると、`/status` に短い要約行が含まれます。

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

これは、ケイパビリティごとの結果と、該当する場合に選択されたプロバイダー／モデルを示します。

## Notes

- 理解は**最善の努力**です。 エラーは返信をブロックしません。
- 理解が無効な場合でも、添付は引き続きモデルに渡されます。
- 理解を実行する場所を制限するには `scope` を使用してください（例: ダイレクトメッセージのみ）。

## 関連ドキュメント

- [設定](/gateway/configuration)
- [画像とメディアのサポート](/nodes/images)
