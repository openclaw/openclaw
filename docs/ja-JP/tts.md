---
summary: "アウトバウンド返信のテキスト読み上げ（TTS）"
read_when:
  - 返信のテキスト読み上げを有効にする場合
  - TTS プロバイダーや制限を設定する場合
  - /tts コマンドを使用する場合
title: "テキスト読み上げ"
---

# テキスト読み上げ（TTS）

OpenClaw は ElevenLabs、OpenAI、または Edge TTS を使用してアウトバウンド返信をオーディオに変換できます。
OpenClaw がオーディオを送信できる場所であればどこでも動作します。Telegram では丸いボイスノートバブルとして届きます。

## サポートされているサービス

- **ElevenLabs**（プライマリまたはフォールバックプロバイダー）
- **OpenAI**（プライマリまたはフォールバックプロバイダー。サマリーにも使用）
- **Edge TTS**（プライマリまたはフォールバックプロバイダー。`node-edge-tts` を使用。API キーがない場合のデフォルト）

### Edge TTS のメモ

Edge TTS は `node-edge-tts` ライブラリを介して Microsoft Edge のオンラインニューラル TTS サービスを使用します。ホスト型サービス（ローカルではない）で Microsoft のエンドポイントを使用し、API キーは不要です。`node-edge-tts` は音声設定オプションと出力フォーマットを公開していますが、すべてのオプションが Edge サービスでサポートされているわけではありません。

Edge TTS は公開 SLA やクォータが公開されていないパブリック Web サービスであるため、ベストエフォートとして扱ってください。保証された制限とサポートが必要な場合は、OpenAI または ElevenLabs を使用してください。Microsoft の Speech REST API はリクエストごとに 10 分間のオーディオ制限をドキュメント化しています。Edge TTS は制限を公開していないため、同様またはより低い制限を想定してください。

## オプションキー

OpenAI または ElevenLabs が必要な場合:

- `ELEVENLABS_API_KEY`（または `XI_API_KEY`）
- `OPENAI_API_KEY`

Edge TTS は API キーを**必要としません**。API キーが見つからない場合、OpenClaw はデフォルトで Edge TTS を使用します（`messages.tts.edge.enabled=false` で無効にしない限り）。

複数のプロバイダーが設定されている場合、選択されたプロバイダーが最初に使用され、他はフォールバックオプションとなります。
自動サマリーは設定された `summaryModel`（または `agents.defaults.model.primary`）を使用するため、サマリーを有効にする場合はそのプロバイダーも認証されている必要があります。

## サービスリンク

- [OpenAI テキスト読み上げガイド](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API リファレンス](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs テキスト読み上げ](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 認証](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech 出力フォーマット](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## デフォルトで有効になっているか？

いいえ。自動 TTS はデフォルトで**オフ**です。コンフィグで `messages.tts.auto` を使用するか、セッションごとに `/tts always`（エイリアス: `/tts on`）で有効にしてください。

Edge TTS は TTS がオンになった時点でデフォルトで有効になっており、OpenAI または ElevenLabs の API キーが利用できない場合に自動的に使用されます。

## コンフィグ

TTS コンフィグは `openclaw.json` の `messages.tts` に置かれます。
完全なスキーマは [Gateway コンフィグ](/gateway/configuration) にあります。

### 最小コンフィグ（有効化 + プロバイダー）

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

### ElevenLabs フォールバック付き OpenAI プライマリ

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
      openai: {
        apiKey: "openai_api_key",
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
}
```

### Edge TTS プライマリ（API キーなし）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Edge TTS を無効にする

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### カスタム制限 + 設定パス

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

### インバウンドボイスノートの後にのみオーディオで返信

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 長い返信の自動サマリーを無効にする

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

その後、実行します:

```
/tts summary off
```

### フィールドのメモ

- `auto`: 自動 TTS モード（`off`、`always`、`inbound`、`tagged`）。
  - `inbound` はインバウンドボイスノートの後にのみオーディオを送信します。
  - `tagged` は返信に `[[tts]]` タグが含まれている場合にのみオーディオを送信します。
- `enabled`: レガシートグル（doctor がこれを `auto` に移行します）。
- `mode`: `"final"`（デフォルト）または `"all"`（ツール/ブロック返信を含む）。
- `provider`: `"elevenlabs"`、`"openai"`、または `"edge"`（フォールバックは自動）。
- `provider` が**未設定**の場合、OpenClaw は `openai`（キーがある場合）、次に `elevenlabs`（キーがある場合）、それ以外は `edge` を優先します。
- `summaryModel`: 自動サマリー用のオプションの安価なモデル。デフォルトは `agents.defaults.model.primary`。
  - `provider/model` または設定されたモデルエイリアスを受け付けます。
- `modelOverrides`: モデルが TTS ディレクティブを出力できるようにします（デフォルトでオン）。
  - `allowProvider` はデフォルトで `false`（プロバイダー切り替えはオプトイン）。
- `maxTextLength`: TTS 入力のハードキャップ（文字数）。`/tts audio` は超過した場合に失敗します。
- `timeoutMs`: リクエストタイムアウト（ミリ秒）。
- `prefsPath`: ローカル設定 JSON パスをオーバーライド（プロバイダー/制限/サマリー）。
- `apiKey` の値は環境変数（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）にフォールバックします。
- `elevenlabs.baseUrl`: ElevenLabs API ベース URL をオーバーライド。
- `elevenlabs.voiceSettings`:
  - `stability`、`similarityBoost`、`style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0`（1.0 = 標準）
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2 文字の ISO 639-1（例: `en`、`de`）
- `elevenlabs.seed`: 整数 `0..4294967295`（ベストエフォートの決定論）
- `edge.enabled`: Edge TTS の使用を許可（デフォルト `true`。API キー不要）。
- `edge.voice`: Edge ニューラル音声名（例: `en-US-MichelleNeural`）。
- `edge.lang`: 言語コード（例: `en-US`）。
- `edge.outputFormat`: Edge 出力フォーマット（例: `audio-24khz-48kbitrate-mono-mp3`）。
  - 有効な値については Microsoft Speech 出力フォーマットを参照。すべてのフォーマットが Edge でサポートされているわけではありません。
- `edge.rate` / `edge.pitch` / `edge.volume`: パーセント文字列（例: `+10%`、`-5%`）。
- `edge.saveSubtitles`: オーディオファイルと並んで JSON サブタイトルを書き込む。
- `edge.proxy`: Edge TTS リクエスト用のプロキシ URL。
- `edge.timeoutMs`: リクエストタイムアウトオーバーライド（ミリ秒）。

## モデル駆動のオーバーライド（デフォルトでオン）

デフォルトでは、モデルは単一の返信のために TTS ディレクティブを出力**できます**。
`messages.tts.auto` が `tagged` の場合、これらのディレクティブはオーディオをトリガーするために必要です。

有効な場合、モデルは `[[tts:...]]` ディレクティブを出力して単一の返信の音声をオーバーライドでき、さらにオプションの `[[tts:text]]...[[/tts:text]]` ブロックでオーディオにのみ表示すべき表現豊かなタグ（笑い声、歌のキューなど）を提供できます。

`provider=...` ディレクティブは `modelOverrides.allowProvider: true` でない限り無視されます。

返信ペイロードの例:

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

利用可能なディレクティブキー（有効な場合）:

- `provider`（`openai` | `elevenlabs` | `edge`、`allowProvider: true` が必要）
- `voice`（OpenAI 音声）または `voiceId`（ElevenLabs）
- `model`（OpenAI TTS モデルまたは ElevenLabs モデル ID）
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
- `applyTextNormalization`（`auto|on|off`）
- `languageCode`（ISO 639-1）
- `seed`

すべてのモデルオーバーライドを無効にする:

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

オプションのアローリスト（他のノブを設定可能に維持しながらプロバイダー切り替えを有効にする）:

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

## ユーザーごとの設定

スラッシュコマンドはローカルオーバーライドを `prefsPath` に書き込みます（デフォルト: `~/.openclaw/settings/tts.json`、`OPENCLAW_TTS_PREFS` または `messages.tts.prefsPath` でオーバーライド可能）。

保存されるフィールド:

- `enabled`
- `provider`
- `maxLength`（サマリーしきい値。デフォルト 1500 文字）
- `summarize`（デフォルト `true`）

これらはそのホストの `messages.tts.*` をオーバーライドします。

## 出力フォーマット（固定）

- **Telegram**: Opus ボイスノート（ElevenLabs からの `opus_48000_64`、OpenAI からの `opus`）。
  - 48kHz / 64kbps は良いボイスノートのトレードオフで、丸いバブルに必要です。
- **その他のチャンネル**: MP3（ElevenLabs からの `mp3_44100_128`、OpenAI からの `mp3`）。
  - 44.1kHz / 128kbps は音声明瞭度のデフォルトバランスです。
- **Edge TTS**: `edge.outputFormat` を使用（デフォルト `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` は `outputFormat` を受け付けますが、すべてのフォーマットが Edge サービスから利用できるわけではありません。
  - 出力フォーマットの値は Microsoft Speech 出力フォーマットに従います（Ogg/WebM Opus を含む）。
  - Telegram の `sendVoice` は OGG/MP3/M4A を受け付けます。保証された Opus ボイスノートが必要な場合は OpenAI/ElevenLabs を使用してください。
  - 設定された Edge 出力フォーマットが失敗した場合、OpenClaw は MP3 で再試行します。

OpenAI/ElevenLabs のフォーマットは固定されています。Telegram はボイスノート UX のために Opus を期待します。

## 自動 TTS の動作

有効な場合、OpenClaw は:

- 返信にすでにメディアまたは `MEDIA:` ディレクティブが含まれている場合、TTS をスキップします。
- 非常に短い返信（< 10 文字）をスキップします。
- 有効な場合、`agents.defaults.model.primary`（または `summaryModel`）を使用して長い返信をサマリーします。
- 生成されたオーディオを返信に添付します。

返信が `maxLength` を超えてサマリーがオフ（またはサマリーモデルの API キーがない）場合、オーディオはスキップされ、通常のテキスト返信が送信されます。

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

## スラッシュコマンドの使用

コマンドは 1 つです: `/tts`。
有効化の詳細については [スラッシュコマンド](/tools/slash-commands) を参照してください。

Discord のメモ: `/tts` は Discord の組み込みコマンドであるため、OpenClaw はネイティブコマンドとして `/voice` を登録します。テキストの `/tts ...` は引き続き動作します。

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

メモ:

- コマンドには承認された送信者が必要です（アローリスト/オーナールールが引き続き適用）。
- `commands.text` またはネイティブコマンド登録が有効になっている必要があります。
- `off|always|inbound|tagged` はセッションごとのトグルです（`/tts on` は `/tts always` のエイリアス）。
- `limit` と `summary` はローカル設定に保存されます。メインコンフィグではありません。
- `/tts audio` はワンオフのオーディオ返信を生成します（TTS をオンにするトグルではありません）。

## エージェントツール

`tts` ツールはテキストを音声に変換し、`MEDIA:` パスを返します。結果が Telegram 互換の場合、ツールは `[[audio_as_voice]]` を含め、Telegram がボイスバブルを送信するようにします。

## Gateway RPC

Gateway メソッド:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
