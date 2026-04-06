---
read_when:
    - メディア理解の設計またはリファクタリング時
    - 受信音声/動画/画像の前処理を調整する場合
summary: 受信画像/音声/動画の理解機能（オプション）とプロバイダー + CLI フォールバック
title: メディア理解
x-i18n:
    generated_at: "2026-04-02T07:47:03Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 482635b05436c1c9665f07c31ae1f3d54507dd56e057a94b8dd7b973575bc6b4
    source_path: nodes/media-understanding.md
    workflow: 15
---

# メディア理解 - 受信 (2026-01-17)

OpenClaw は返信パイプラインの実行前に**受信メディア**（画像/音声/動画）を**要約**できます。ローカルツールやプロバイダーキーが利用可能な場合を自動検出し、無効化やカスタマイズも可能です。理解機能がオフの場合でも、モデルは通常どおり元のファイル/URL を受け取ります。

ベンダー固有のメディア動作はベンダープラグインによって登録され、OpenClaw
コアは共有の `tools.media` 設定、フォールバック順序、および返信パイプライン
統合を所有します。

## 目標

- オプション: 受信メディアを短いテキストに事前変換し、より高速なルーティングとより良いコマンド解析を実現する。
- モデルへの元のメディア配信を常に保持する。
- **プロバイダー API** と **CLI フォールバック**をサポートする。
- 順序付きフォールバック（エラー/サイズ/タイムアウト）で複数モデルをサポートする。

## 高レベルの動作

1. 受信添付ファイルを収集する（`MediaPaths`、`MediaUrls`、`MediaTypes`）。
2. 有効な各機能（画像/音声/動画）について、ポリシーに従って添付ファイルを選択する（デフォルト: **最初の1つ**）。
3. 最初の適格なモデルエントリを選択する（サイズ + 機能 + 認証）。
4. モデルが失敗した場合やメディアが大きすぎる場合、**次のエントリにフォールバック**する。
5. 成功時:
   - `Body` が `[Image]`、`[Audio]`、または `[Video]` ブロックになる。
   - 音声は `{{Transcript}}` を設定する。コマンド解析はキャプションテキストがある場合はそれを使用し、
     ない場合はトランスクリプトを使用する。
   - キャプションはブロック内に `User text:` として保持される。

理解が失敗した場合または無効な場合、**返信フローは**元の本文と添付ファイルで**続行される**。

## 設定概要

`tools.media` は**共有モデル**と機能ごとのオーバーライドをサポートします:

- `tools.media.models`: 共有モデルリスト（`capabilities` でゲートに使用）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - デフォルト値（`prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`）
  - プロバイダーオーバーライド（`baseUrl`、`headers`、`providerOptions`）
  - Deepgram 音声オプション（`tools.media.audio.providerOptions.deepgram` 経由）
  - 音声トランスクリプトエコー制御（`echoTranscript`、デフォルト `false`; `echoFormat`）
  - オプションの**機能ごとの `models` リスト**（共有モデルより優先）
  - `attachments` ポリシー（`mode`、`maxAttachments`、`prefer`）
  - `scope`（チャネル/チャットタイプ/セッションキーによるオプションのゲート）
- `tools.media.concurrency`: 最大同時実行機能数（デフォルト **2**）。

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
        echoTranscript: true,
        echoFormat: '📝 "{transcript}"',
      },
      video: {
        /* オプションのオーバーライド */
      },
    },
  },
}
```

### モデルエントリ

各 `models[]` エントリは**プロバイダー**または **CLI** のいずれかです:

```json5
{
  type: "provider", // 省略時のデフォルト
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
- `{{OutputDir}}`（この実行のために作成されたスクラッチディレクトリ）
- `{{OutputBase}}`（スクラッチファイルのベースパス、拡張子なし）

## デフォルトと制限

推奨デフォルト:

- `maxChars`: 画像/動画は **500**（短く、コマンド向け）
- `maxChars`: 音声は**未設定**（制限を設定しない限り完全なトランスクリプト）
- `maxBytes`:
  - 画像: **10MB**
  - 音声: **20MB**
  - 動画: **50MB**

ルール:

- メディアが `maxBytes` を超える場合、そのモデルはスキップされ**次のモデルが試行される**。
- **1024 バイト**未満の音声ファイルは空/破損として扱われ、プロバイダー/CLI での文字起こし前にスキップされる。
- モデルが `maxChars` を超える出力を返した場合、出力はトリミングされる。
- `prompt` のデフォルトはシンプルな「Describe the {media}.」に `maxChars` ガイダンスを加えたもの（画像/動画のみ）。
- `<capability>.enabled: true` だがモデルが設定されていない場合、OpenClaw は
  プロバイダーがその機能をサポートしている場合に**アクティブな返信モデル**を試行する。

### メディア理解の自動検出（デフォルト）

`tools.media.<capability>.enabled` が `false` に設定されておらず、モデルを
設定していない場合、OpenClaw はこの順序で自動検出し、**最初に動作するオプションで
停止**します:

1. **ローカル CLI**（音声のみ、インストールされている場合）
   - `sherpa-onnx-offline`（`SHERPA_ONNX_MODEL_DIR` にエンコーダー/デコーダー/ジョイナー/トークンが必要）
   - `whisper-cli`（`whisper-cpp`、`WHISPER_CPP_MODEL` またはバンドルされた tiny モデルを使用）
   - `whisper`（Python CLI、モデルを自動ダウンロード）
2. **Gemini CLI**（`gemini`）`read_many_files` を使用
3. **プロバイダーキー**
   - 音声: OpenAI → Groq → Deepgram → Google
   - 画像: OpenAI → Anthropic → Google → MiniMax
   - 動画: Google

自動検出を無効にするには、以下を設定します:

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

注意: バイナリ検出は macOS/Linux/Windows でベストエフォートです。CLI が `PATH` 上にあることを確認するか（`~` は展開されます）、フルコマンドパスで明示的な CLI モデルを設定してください。

### プロキシ環境変数のサポート（プロバイダーモデル）

プロバイダーベースの**音声**および**動画**メディア理解が有効な場合、OpenClaw は
プロバイダー HTTP 呼び出しに標準のアウトバウンドプロキシ環境変数を尊重します:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

プロキシ環境変数が設定されていない場合、メディア理解は直接送信を使用します。
プロキシ値が不正な形式の場合、OpenClaw は警告をログに記録し、直接フェッチに
フォールバックします。

## 機能（オプション）

`capabilities` を設定すると、そのエントリはそのメディアタイプでのみ実行されます。共有
リストの場合、OpenClaw はデフォルトを推論できます:

- `openai`、`anthropic`、`minimax`: **画像**
- `moonshot`: **画像 + 動画**
- `google`（Gemini API）: **画像 + 音声 + 動画**
- `mistral`: **音声**
- `zai`: **画像**
- `groq`: **音声**
- `deepgram`: **音声**

CLI エントリの場合、予期しないマッチを避けるため **`capabilities` を明示的に設定**してください。
`capabilities` を省略した場合、エントリはそれが含まれるリストに対して適格になります。

## プロバイダーサポートマトリクス（OpenClaw 統合）

| 機能 | プロバイダー統合 | 備考 |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| 画像 | OpenAI、Anthropic、Google、MiniMax、Moonshot、Z.AI | ベンダープラグインがコアのメディア理解に対して画像サポートを登録する。 |
| 音声 | OpenAI、Groq、Deepgram、Google、Mistral | プロバイダー文字起こし（Whisper/Deepgram/Gemini/Voxtral）。 |
| 動画 | Google、Moonshot | ベンダープラグイン経由のプロバイダー動画理解。 |

## モデル選択ガイダンス

- 品質と安全性が重要な場合、各メディア機能で利用可能な最新世代の最強モデルを優先する。
- 信頼されない入力を処理するツール対応エージェントでは、古い/弱いメディアモデルを避ける。
- 可用性のために機能ごとに少なくとも1つのフォールバックを用意する（品質モデル + より高速/安価なモデル）。
- CLI フォールバック（`whisper-cli`、`whisper`、`gemini`）はプロバイダー API が利用できない場合に有用。
- `parakeet-mlx` に関する注意: `--output-dir` を使用する場合、OpenClaw は出力形式が `txt`（または未指定）のとき `<output-dir>/<media-basename>.txt` を読み取り、`txt` 以外の形式は標準出力にフォールバックする。

## 添付ファイルポリシー

機能ごとの `attachments` で処理する添付ファイルを制御します:

- `mode`: `first`（デフォルト）または `all`
- `maxAttachments`: 処理数の上限（デフォルト **1**）
- `prefer`: `first`、`last`、`path`、`url`

`mode: "all"` の場合、出力は `[Image 1/2]`、`[Audio 2/2]` などのラベルが付けられます。

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

### 2) 音声 + 動画のみ（画像オフ）

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

### 4) マルチモーダル単一エントリ（明示的な機能指定）

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## ステータス出力

メディア理解が実行されると、`/status` に短い要約行が含まれます:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

これは機能ごとの結果と、該当する場合は選択されたプロバイダー/モデルを表示します。

## 備考

- 理解は**ベストエフォート**です。エラーが返信をブロックすることはありません。
- 理解が無効な場合でも、添付ファイルはモデルに渡されます。
- `scope` を使用して理解が実行される場所を制限できます（例: ダイレクトメッセージのみ）。

## 関連ドキュメント

- [設定](/gateway/configuration)
- [画像・メディアサポート](/nodes/images)
