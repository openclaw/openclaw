---
read_when:
    - 返信のテキスト読み上げを有効にする
    - TTSプロバイダーや制限の設定
    - /tts コマンドの使用
summary: 送信メッセージのテキスト読み上げ（TTS）
title: テキスト読み上げ（レガシーパス）
x-i18n:
    generated_at: "2026-04-02T08:41:44Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a6d765d17d4fcfd38f39e0c8786674ecbf38c427da7723ef2002972357a137aa
    source_path: tts.md
    workflow: 15
---

# テキスト読み上げ（TTS）

OpenClaw は ElevenLabs、Microsoft、または OpenAI を使用して送信メッセージを音声に変換できます。
OpenClaw が音声を送信できる場所であればどこでも動作します。

## 対応サービス

- **ElevenLabs**（プライマリまたはフォールバックプロバイダー）
- **Microsoft**（プライマリまたはフォールバックプロバイダー。現在のバンドル実装は `node-edge-tts` を使用）
- **OpenAI**（プライマリまたはフォールバックプロバイダー。要約にも使用）

### Microsoft 音声に関する注意

バンドルされている Microsoft 音声プロバイダーは、現在 `node-edge-tts` ライブラリを通じて Microsoft Edge のオンラインニューラル TTS サービスを使用しています。これはホスティングされたサービスであり（ローカルではありません）、Microsoft のエンドポイントを使用し、API キーは不要です。
`node-edge-tts` は音声設定オプションと出力形式を公開していますが、すべてのオプションがサービスでサポートされているわけではありません。`edge` を使用するレガシー設定やディレクティブ入力は引き続き動作し、`microsoft` に正規化されます。

このパスは公開 Web サービスであり、SLA やクォータが公開されていないため、ベストエフォートとして扱ってください。保証された制限やサポートが必要な場合は、OpenAI または ElevenLabs を使用してください。

## オプションのキー

OpenAI または ElevenLabs を使用する場合：

- `ELEVENLABS_API_KEY`（または `XI_API_KEY`）
- `OPENAI_API_KEY`

Microsoft 音声は API キーを**必要としません**。

複数のプロバイダーが設定されている場合、選択されたプロバイダーが最初に使用され、他のプロバイダーがフォールバックオプションになります。
自動要約は設定された `summaryModel`（または `agents.defaults.model.primary`）を使用するため、要約を有効にする場合はそのプロバイダーも認証されている必要があります。

## サービスリンク

- [OpenAI テキスト読み上げガイド](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API リファレンス](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 認証](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 音声出力形式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## デフォルトで有効ですか？

いいえ。自動 TTS はデフォルトで**オフ**です。設定で `messages.tts.auto` を使用するか、セッションごとに `/tts always`（エイリアス: `/tts on`）で有効にしてください。

`messages.tts.provider` が未設定の場合、OpenClaw はレジストリの自動選択順で最初に設定された音声プロバイダーを選択します。

## 設定

TTS 設定は `openclaw.json` の `messages.tts` に配置されます。
完全なスキーマは [Gateway ゲートウェイ設定](/gateway/configuration) を参照してください。

### 最小設定（有効化 + プロバイダー）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI プライマリ + ElevenLabs フォールバック

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      providers: {
        openai: {
          apiKey: "openai_api_key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
        elevenlabs: {
          apiKey: "elevenlabs_api_key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "voice_id",
          modelId: "eleven_multilingual_v2",
          seed: 42,
          applyTextNormalization: "auto",
          languageCode: "en",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0.0,
            useSpeakerBoost: true,
            speed: 1.0,
          },
        },
      },
    },
  },
}
```

### Microsoft プライマリ（API キー不要）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "microsoft",
      providers: {
        microsoft: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate: "+10%",
          pitch: "-5%",
        },
      },
    },
  },
}
```

### Microsoft 音声を無効にする

```json5
{
  messages: {
    tts: {
      providers: {
        microsoft: {
          enabled: false,
        },
      },
    },
  },
}
```

### カスタム制限 + プリファレンスパス

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### 受信音声メッセージの後のみ音声で返信する

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 長い返信の自動要約を無効にする

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

次に以下を実行します：

```
/tts summary off
```

### フィールドに関する注意

- `auto`: 自動 TTS モード（`off`、`always`、`inbound`、`tagged`）。
  - `inbound` は受信音声メッセージの後のみ音声を送信します。
  - `tagged` は返信に `[[tts]]` タグが含まれている場合のみ音声を送信します。
- `enabled`: レガシートグル（Doctor がこれを `auto` に移行します）。
- `mode`: `"final"`（デフォルト）または `"all"`（ツール/ブロック返信を含む）。
- `provider`: `"elevenlabs"`、`"microsoft"`、`"openai"` などの音声プロバイダー ID（フォールバックは自動）。
- `provider` が**未設定**の場合、OpenClaw はレジストリの自動選択順で最初に設定された音声プロバイダーを使用します。
- レガシーの `provider: "edge"` は引き続き動作し、`microsoft` に正規化されます。
- `summaryModel`: 自動要約用のオプションの軽量モデル。デフォルトは `agents.defaults.model.primary`。
  - `provider/model` または設定済みのモデルエイリアスを受け付けます。
- `modelOverrides`: モデルが TTS ディレクティブを出力することを許可します（デフォルトでオン）。
  - `allowProvider` のデフォルトは `false`（プロバイダー切り替えはオプトイン）。
- `providers.<id>`: 音声プロバイダー ID をキーとするプロバイダー固有の設定。
- レガシーの直接プロバイダーブロック（`messages.tts.openai`、`messages.tts.elevenlabs`、`messages.tts.microsoft`、`messages.tts.edge`）は読み込み時に `messages.tts.providers.<id>` に自動移行されます。
- `maxTextLength`: TTS 入力のハード上限（文字数）。超過すると `/tts audio` は失敗します。
- `timeoutMs`: リクエストタイムアウト（ミリ秒）。
- `prefsPath`: ローカルプリファレンス JSON パスの上書き（プロバイダー/制限/要約）。
- `apiKey` の値は環境変数にフォールバックします（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）。
- `providers.elevenlabs.baseUrl`: ElevenLabs API ベース URL の上書き。
- `providers.openai.baseUrl`: OpenAI TTS エンドポイントの上書き。
  - 解決順序: `messages.tts.providers.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - デフォルト以外の値は OpenAI 互換 TTS エンドポイントとして扱われるため、カスタムモデル名やボイス名が受け付けられます。
- `providers.elevenlabs.voiceSettings`:
  - `stability`、`similarityBoost`、`style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0`（1.0 = 通常速度）
- `providers.elevenlabs.applyTextNormalization`: `auto|on|off`
- `providers.elevenlabs.languageCode`: 2文字の ISO 639-1 コード（例: `en`、`de`）
- `providers.elevenlabs.seed`: 整数 `0..4294967295`（ベストエフォートの決定性）
- `providers.microsoft.enabled`: Microsoft 音声の使用を許可（デフォルト `true`、API キー不要）。
- `providers.microsoft.voice`: Microsoft ニューラルボイス名（例: `en-US-MichelleNeural`）。
- `providers.microsoft.lang`: 言語コード（例: `en-US`）。
- `providers.microsoft.outputFormat`: Microsoft 出力形式（例: `audio-24khz-48kbitrate-mono-mp3`）。
  - 有効な値については Microsoft 音声出力形式を参照してください。バンドルされた Edge ベースのトランスポートではすべての形式がサポートされているわけではありません。
- `providers.microsoft.rate` / `providers.microsoft.pitch` / `providers.microsoft.volume`: パーセント文字列（例: `+10%`、`-5%`）。
- `providers.microsoft.saveSubtitles`: 音声ファイルと一緒に JSON 字幕を書き出します。
- `providers.microsoft.proxy`: Microsoft 音声リクエスト用のプロキシ URL。
- `providers.microsoft.timeoutMs`: リクエストタイムアウトの上書き（ミリ秒）。
- `edge.*`: 同じ Microsoft 設定のレガシーエイリアス。

## モデル駆動のオーバーライド（デフォルトでオン）

デフォルトでは、モデルは単一の返信に対して TTS ディレクティブを出力**できます**。
`messages.tts.auto` が `tagged` の場合、音声をトリガーするにはこれらのディレクティブが必要です。

有効にすると、モデルは `[[tts:...]]` ディレクティブを出力して単一の返信のボイスをオーバーライドでき、オプションの `[[tts:text]]...[[/tts:text]]` ブロックで音声のみに含めるべき表現的なタグ（笑い声、歌のキューなど）を提供できます。

`provider=...` ディレクティブは `modelOverrides.allowProvider: true` でない限り無視されます。

返信ペイロードの例：

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

利用可能なディレクティブキー（有効時）：

- `provider`（登録済み音声プロバイダー ID、例: `openai`、`elevenlabs`、`microsoft`。`allowProvider: true` が必要）
- `voice`（OpenAI ボイス）または `voiceId`（ElevenLabs）
- `model`（OpenAI TTS モデルまたは ElevenLabs モデル ID）
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
- `applyTextNormalization`（`auto|on|off`）
- `languageCode`（ISO 639-1）
- `seed`

すべてのモデルオーバーライドを無効にする：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

オプションの許可リスト（プロバイダー切り替えを有効にしつつ他の設定項目も設定可能にする）：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: true,
        allowSeed: false,
      },
    },
  },
}
```

## ユーザーごとのプリファレンス

スラッシュコマンドは `prefsPath`（デフォルト: `~/.openclaw/settings/tts.json`、`OPENCLAW_TTS_PREFS` または `messages.tts.prefsPath` で上書き可能）にローカルオーバーライドを書き込みます。

保存されるフィールド：

- `enabled`
- `provider`
- `maxLength`（要約の閾値。デフォルトは 1500 文字）
- `summarize`（デフォルト `true`）

これらはそのホストの `messages.tts.*` を上書きします。

## 出力形式（固定）

- **Feishu / Matrix / Telegram / WhatsApp**: Opus ボイスメッセージ（ElevenLabs では `opus_48000_64`、OpenAI では `opus`）。
  - 48kHz / 64kbps はボイスメッセージに適したバランスです。
- **その他のチャネル**: MP3（ElevenLabs では `mp3_44100_128`、OpenAI では `mp3`）。
  - 44.1kHz / 128kbps は音声の明瞭さのデフォルトバランスです。
- **Microsoft**: `microsoft.outputFormat` を使用（デフォルト `audio-24khz-48kbitrate-mono-mp3`）。
  - バンドルされたトランスポートは `outputFormat` を受け付けますが、すべての形式がサービスから利用できるわけではありません。
  - 出力形式の値は Microsoft 音声出力形式に準拠します（Ogg/WebM Opus を含む）。
  - Telegram の `sendVoice` は OGG/MP3/M4A を受け付けます。Opus ボイスメッセージを保証する必要がある場合は OpenAI/ElevenLabs を使用してください。
  - 設定された Microsoft 出力形式が失敗した場合、OpenClaw は MP3 でリトライします。

OpenAI/ElevenLabs の出力形式はチャネルごとに固定です（上記参照）。

## 自動 TTS の動作

有効にすると、OpenClaw は：

- 返信にメディアまたは `MEDIA:` ディレクティブが既に含まれている場合、TTS をスキップします。
- 非常に短い返信（10 文字未満）をスキップします。
- 有効な場合、`agents.defaults.model.primary`（または `summaryModel`）を使用して長い返信を要約します。
- 生成された音声を返信に添付します。

返信が `maxLength` を超え、要約がオフ（または要約モデルの API キーがない）の場合、音声はスキップされ、通常のテキスト返信が送信されます。

## フロー図

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## スラッシュコマンドの使い方

コマンドは `/tts` の1つです。
有効化の詳細は[スラッシュコマンド](/tools/slash-commands)を参照してください。

Discord に関する注意: `/tts` は Discord の組み込みコマンドのため、OpenClaw はそこでは `/voice` をネイティブコマンドとして登録します。テキストの `/tts ...` は引き続き動作します。

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

注意事項：

- コマンドには認可済みの送信者が必要です（許可リスト/オーナールールが引き続き適用されます）。
- `commands.text` またはネイティブコマンド登録が有効になっている必要があります。
- `off|always|inbound|tagged` はセッションごとのトグルです（`/tts on` は `/tts always` のエイリアスです）。
- `limit` と `summary` はメイン設定ではなくローカルプリファレンスに保存されます。
- `/tts audio` は1回限りの音声返信を生成します（TTS を有効にするトグルではありません）。
- `/tts status` には最新の試行のフォールバック情報が含まれます：
  - フォールバック成功: `Fallback: <primary> -> <used>` および `Attempts: ...`
  - 失敗: `Error: ...` および `Attempts: ...`
  - 詳細な診断: `Attempt details: provider:outcome(reasonCode) latency`
- OpenAI と ElevenLabs の API エラーには、パースされたプロバイダーエラーの詳細とリクエスト ID（プロバイダーから返された場合）が含まれるようになり、TTS エラー/ログに表示されます。

## エージェントツール

`tts` ツールはテキストを音声に変換し、返信配信用の音声添付ファイルを返します。チャネルが Feishu、Matrix、Telegram、または WhatsApp の場合、音声はファイル添付ではなくボイスメッセージとして配信されます。

## Gateway ゲートウェイ RPC

Gateway ゲートウェイメソッド：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
