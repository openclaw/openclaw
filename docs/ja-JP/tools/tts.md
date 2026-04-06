---
read_when:
    - 返信のテキスト読み上げを有効にする
    - TTSプロバイダーや制限を設定する
    - /tts コマンドを使用する
summary: 送信メッセージのテキスト読み上げ（TTS）
title: テキスト読み上げ
x-i18n:
    generated_at: "2026-04-02T08:41:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 910b5aca0c89fef2540d59c366a14ce7c4f4e751a36d6fa9033cdd5c52c90bf7
    source_path: tools/tts.md
    workflow: 15
---

# テキスト読み上げ（TTS）

OpenClawは、ElevenLabs、Microsoft、またはOpenAIを使用して送信メッセージを音声に変換できます。
OpenClawが音声を送信できる場所であればどこでも動作します。

## 対応サービス

- **ElevenLabs**（プライマリまたはフォールバックプロバイダー）
- **Microsoft**（プライマリまたはフォールバックプロバイダー。現在のバンドル実装は`node-edge-tts`を使用）
- **OpenAI**（プライマリまたはフォールバックプロバイダー。要約にも使用）

### Microsoft音声に関する注意

バンドルされているMicrosoft音声プロバイダーは、現在`node-edge-tts`ライブラリを介してMicrosoft EdgeのオンラインニューラルTTSサービスを使用しています。これはホスト型サービス（ローカルではない）であり、Microsoftのエンドポイントを使用し、APIキーは不要です。
`node-edge-tts`は音声設定オプションと出力形式を公開していますが、すべてのオプションがサービスでサポートされているわけではありません。`edge`を使用するレガシー設定やディレクティブ入力は引き続き動作し、`microsoft`に正規化されます。

このパスはSLAやクォータが公開されていないパブリックWebサービスのため、ベストエフォートとして扱ってください。保証された制限やサポートが必要な場合は、OpenAIまたはElevenLabsを使用してください。

## オプションのキー

OpenAIまたはElevenLabsを使用する場合：

- `ELEVENLABS_API_KEY`（または`XI_API_KEY`）
- `OPENAI_API_KEY`

Microsoft音声はAPIキーが**不要**です。

複数のプロバイダーが設定されている場合、選択されたプロバイダーが最初に使用され、他のプロバイダーはフォールバックオプションになります。
自動要約は設定された`summaryModel`（または`agents.defaults.model.primary`）を使用するため、要約を有効にする場合はそのプロバイダーも認証されている必要があります。

## サービスリンク

- [OpenAI Text-to-Speechガイド](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio APIリファレンス](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs認証](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft音声出力形式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## デフォルトで有効ですか？

いいえ。自動TTSはデフォルトで**オフ**です。設定で`messages.tts.auto`を使用するか、セッションごとに`/tts always`（エイリアス：`/tts on`）で有効にしてください。

`messages.tts.provider`が未設定の場合、OpenClawはレジストリの自動選択順序で最初に設定された音声プロバイダーを選択します。

## 設定

TTS設定は`openclaw.json`の`messages.tts`にあります。
完全なスキーマは[Gateway ゲートウェイ設定](/gateway/configuration)を参照してください。

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

### OpenAIプライマリ + ElevenLabsフォールバック

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

### Microsoftプライマリ（APIキー不要）

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

### Microsoft音声を無効にする

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

その後、以下を実行します：

```
/tts summary off
```

### フィールドに関する注意

- `auto`：自動TTSモード（`off`、`always`、`inbound`、`tagged`）。
  - `inbound`は受信音声メッセージの後のみ音声を送信します。
  - `tagged`は返信に`[[tts]]`タグが含まれている場合のみ音声を送信します。
- `enabled`：レガシートグル（Doctorがこれを`auto`に移行します）。
- `mode`：`"final"`（デフォルト）または`"all"`（ツール/ブロック返信を含む）。
- `provider`：音声プロバイダーID。`"elevenlabs"`、`"microsoft"`、`"openai"`など（フォールバックは自動）。
- `provider`が**未設定**の場合、OpenClawはレジストリの自動選択順序で最初に設定された音声プロバイダーを使用します。
- レガシーの`provider: "edge"`は引き続き動作し、`microsoft`に正規化されます。
- `summaryModel`：自動要約用のオプションの軽量モデル。デフォルトは`agents.defaults.model.primary`。
  - `provider/model`または設定済みのモデルエイリアスを受け付けます。
- `modelOverrides`：モデルがTTSディレクティブを出力することを許可します（デフォルトでオン）。
  - `allowProvider`のデフォルトは`false`（プロバイダー切り替えはオプトイン）。
- `providers.<id>`：音声プロバイダーIDをキーとしたプロバイダー固有の設定。
- レガシーの直接プロバイダーブロック（`messages.tts.openai`、`messages.tts.elevenlabs`、`messages.tts.microsoft`、`messages.tts.edge`）はロード時に`messages.tts.providers.<id>`に自動移行されます。
- `maxTextLength`：TTS入力の文字数ハード制限。超過すると`/tts audio`は失敗します。
- `timeoutMs`：リクエストタイムアウト（ミリ秒）。
- `prefsPath`：ローカルプリファレンスJSONパス（プロバイダー/制限/要約）のオーバーライド。
- `apiKey`の値は環境変数（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）にフォールバックします。
- `providers.elevenlabs.baseUrl`：ElevenLabs APIベースURLのオーバーライド。
- `providers.openai.baseUrl`：OpenAI TTSエンドポイントのオーバーライド。
  - 解決順序：`messages.tts.providers.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - デフォルト以外の値はOpenAI互換のTTSエンドポイントとして扱われるため、カスタムモデル名やボイス名が受け付けられます。
- `providers.elevenlabs.voiceSettings`：
  - `stability`、`similarityBoost`、`style`：`0..1`
  - `useSpeakerBoost`：`true|false`
  - `speed`：`0.5..2.0`（1.0 = 通常）
- `providers.elevenlabs.applyTextNormalization`：`auto|on|off`
- `providers.elevenlabs.languageCode`：2文字のISO 639-1（例：`en`、`de`）
- `providers.elevenlabs.seed`：整数`0..4294967295`（ベストエフォートの決定性）
- `providers.microsoft.enabled`：Microsoft音声の使用を許可（デフォルト`true`。APIキー不要）。
- `providers.microsoft.voice`：Microsoftニューラルボイス名（例：`en-US-MichelleNeural`）。
- `providers.microsoft.lang`：言語コード（例：`en-US`）。
- `providers.microsoft.outputFormat`：Microsoft出力形式（例：`audio-24khz-48kbitrate-mono-mp3`）。
  - 有効な値はMicrosoft音声出力形式を参照してください。すべての形式がバンドルされたEdgeバックエンドのトランスポートでサポートされているわけではありません。
- `providers.microsoft.rate` / `providers.microsoft.pitch` / `providers.microsoft.volume`：パーセント文字列（例：`+10%`、`-5%`）。
- `providers.microsoft.saveSubtitles`：音声ファイルと一緒にJSON字幕を書き出します。
- `providers.microsoft.proxy`：Microsoft音声リクエスト用のプロキシURL。
- `providers.microsoft.timeoutMs`：リクエストタイムアウトのオーバーライド（ミリ秒）。
- `edge.*`：同じMicrosoft設定のレガシーエイリアス。

## モデル主導のオーバーライド（デフォルトでオン）

デフォルトでは、モデルは単一の返信に対してTTSディレクティブを出力**できます**。
`messages.tts.auto`が`tagged`の場合、音声をトリガーするにはこれらのディレクティブが必要です。

有効な場合、モデルは`[[tts:...]]`ディレクティブを出力して単一の返信のボイスをオーバーライドでき、さらにオプションの`[[tts:text]]...[[/tts:text]]`ブロックで音声のみに含めるべき表現タグ（笑い声、歌のキューなど）を提供できます。

`provider=...`ディレクティブは`modelOverrides.allowProvider: true`でない限り無視されます。

返信ペイロードの例：

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

利用可能なディレクティブキー（有効時）：

- `provider`（登録済み音声プロバイダーID。例：`openai`、`elevenlabs`、`microsoft`。`allowProvider: true`が必要）
- `voice`（OpenAIボイス）または`voiceId`（ElevenLabs）
- `model`（OpenAI TTSモデルまたはElevenLabsモデルID）
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

オプションの許可リスト（プロバイダー切り替えを有効にしつつ他の設定を維持）：

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

スラッシュコマンドは`prefsPath`（デフォルト：`~/.openclaw/settings/tts.json`、`OPENCLAW_TTS_PREFS`または`messages.tts.prefsPath`でオーバーライド可能）にローカルオーバーライドを書き込みます。

保存されるフィールド：

- `enabled`
- `provider`
- `maxLength`（要約しきい値。デフォルト1500文字）
- `summarize`（デフォルト`true`）

これらはそのホストの`messages.tts.*`をオーバーライドします。

## 出力形式（固定）

- **Feishu / Matrix / Telegram / WhatsApp**：Opusボイスメッセージ（ElevenLabsの`opus_48000_64`、OpenAIの`opus`）。
  - 48kHz / 64kbpsはボイスメッセージに適したバランスです。
- **その他のチャネル**：MP3（ElevenLabsの`mp3_44100_128`、OpenAIの`mp3`）。
  - 44.1kHz / 128kbpsは音声の明瞭さのデフォルトバランスです。
- **Microsoft**：`microsoft.outputFormat`を使用（デフォルト`audio-24khz-48kbitrate-mono-mp3`）。
  - バンドルされたトランスポートは`outputFormat`を受け付けますが、すべての形式がサービスから利用できるわけではありません。
  - 出力形式の値はMicrosoft音声出力形式（Ogg/WebM Opusを含む）に準拠します。
  - Telegramの`sendVoice`はOGG/MP3/M4Aを受け付けます。保証されたOpusボイスメッセージが必要な場合はOpenAI/ElevenLabsを使用してください。
  - 設定されたMicrosoft出力形式が失敗した場合、OpenClawはMP3で再試行します。

OpenAI/ElevenLabsの出力形式はチャネルごとに固定されています（上記参照）。

## 自動TTS動作

有効な場合、OpenClawは以下の動作をします：

- 返信にすでにメディアまたは`MEDIA:`ディレクティブが含まれている場合、TTSをスキップします。
- 非常に短い返信（10文字未満）はスキップします。
- 有効な場合、`agents.defaults.model.primary`（または`summaryModel`）を使用して長い返信を要約します。
- 生成された音声を返信に添付します。

返信が`maxLength`を超え、要約がオフ（または要約モデルのAPIキーがない）場合、音声はスキップされ通常のテキスト返信が送信されます。

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

## スラッシュコマンドの使用方法

コマンドは1つです：`/tts`。
有効化の詳細は[スラッシュコマンド](/tools/slash-commands)を参照してください。

Discordに関する注意：`/tts`はDiscordの組み込みコマンドのため、OpenClawはネイティブコマンドとして`/voice`を登録します。テキストの`/tts ...`は引き続き動作します。

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

- コマンドには認可された送信者が必要です（許可リスト/オーナールールが引き続き適用されます）。
- `commands.text`またはネイティブコマンド登録が有効になっている必要があります。
- `off|always|inbound|tagged`はセッションごとのトグルです（`/tts on`は`/tts always`のエイリアスです）。
- `limit`と`summary`はメイン設定ではなくローカルプリファレンスに保存されます。
- `/tts audio`は一回限りの音声返信を生成します（TTSをオンにするトグルではありません）。
- `/tts status`には最新の試行のフォールバック情報が含まれます：
  - 成功時のフォールバック：`Fallback: <primary> -> <used>` および `Attempts: ...`
  - 失敗時：`Error: ...` および `Attempts: ...`
  - 詳細な診断：`Attempt details: provider:outcome(reasonCode) latency`
- OpenAIおよびElevenLabsのAPI失敗には、解析されたプロバイダーエラーの詳細とリクエストID（プロバイダーから返された場合）が含まれるようになり、TTSエラー/ログに表示されます。

## エージェントツール

`tts`ツールはテキストを音声に変換し、返信配信用の音声添付ファイルを返します。チャネルがFeishu、Matrix、Telegram、またはWhatsAppの場合、音声はファイル添付ではなくボイスメッセージとして配信されます。

## Gateway ゲートウェイ RPC

Gateway ゲートウェイメソッド：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
