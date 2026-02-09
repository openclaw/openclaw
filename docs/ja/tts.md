---
summary: "送信される返信のためのテキスト読み上げ（TTS）"
read_when:
  - 返信に対してテキスト読み上げを有効化する場合
  - TTS プロバイダーや制限を設定する場合
  - /tts コマンドを使用する場合
title: "テキスト読み上げ"
---

# テキスト読み上げ（TTS）

OpenClawはElevenLabs、OpenAI、またはEdge TTSを使用してアウトバウンドリプライをオーディオに変換できます。
OpenClaw は、ElevenLabs、OpenAI、または Edge TTS を使用して、送信される返信を音声に変換できます。
OpenClaw が音声を送信できるすべての場所で動作し、Telegram では丸いボイスノートのバブルとして表示されます。

## サポートされているサービス

- **ElevenLabs**（プライマリまたはフォールバック プロバイダー）
- **OpenAI**（プライマリまたはフォールバック プロバイダー。要約にも使用）
- **Edge TTS**（プライマリまたはフォールバック プロバイダー。`node-edge-tts` を使用し、API キーがない場合のデフォルト）

### Edge TTS の注記

Edge TTS は、`node-edge-tts` ライブラリを介して Microsoft Edge のオンライン ニューラル TTS サービスを使用します。
これはローカルではなくホステッド サービスであり、Microsoft のエンドポイントを使用し、API キーは不要です。
`node-edge-tts` は音声設定オプションや出力フォーマットを公開していますが、すべてのオプションが Edge サービスでサポートされているわけではありません。citeturn2search0 27. これはホスト型サービス（ローカルではありません）で、Microsoft のエンドポイントを使用し、
API キーは不要です。 `node-edge-tts` は音声設定オプションと
出力フォーマットを公開しますが、エッジサービスではすべてのオプションがサポートされているわけではありません。 <unk> cite<unk> turn2search0<unk>

Edge TTSは公開されたSLAまたはクォータを持たない公開Webサービスであるため、
を最善の努力として扱います。 制限とサポートが保証される必要がある場合は、OpenAIまたはElevenLabsを使用してください。
Edge TTS は公開 Web サービスであり、公開された SLA やクォータがないため、ベストエフォートとして扱ってください。
保証された制限やサポートが必要な場合は、OpenAI または ElevenLabs を使用してください。
Microsoft の Speech REST API では、1 リクエストあたり 10 分の音声制限が文書化されていますが、Edge TTS は制限を公開していないため、同等またはそれ以下と想定してください。citeturn0search3 <unk> cite<unk> turn0search3<unk>

## 任意のキー

OpenAI または ElevenLabs を使用する場合：

- `ELEVENLABS_API_KEY`（または `XI_API_KEY`）
- `OPENAI_API_KEY`

Edge TTSはAPIキーを必要としません。 Edge TTS には **API キーは不要** です。API キーが見つからない場合、OpenClaw は Edge TTS をデフォルトで使用します（`messages.tts.edge.enabled=false` で無効化されていない場合）。

複数のプロバイダが設定されている場合、選択されたプロバイダが最初に使用され、他のプロバイダはフォールバックオプションです。
複数のプロバイダーが設定されている場合、選択されたプロバイダーが最初に使用され、他はフォールバック オプションとして利用されます。
自動要約は設定された `summaryModel`（または `agents.defaults.model.primary`）を使用するため、
要約を有効にする場合、そのプロバイダーも認証されている必要があります。

## サービスリンク

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## デフォルトで有効ですか？

いいえ. 自動TTSはデフォルトで**オフ**です。 いいえ。自動 TTS はデフォルトで **オフ** です。設定で `messages.tts.auto` を使用するか、
セッションごとに `/tts always`（エイリアス: `/tts on`）で有効化してください。

TTS をオンにすると Edge TTS はデフォルトで **有効** になり、
OpenAI や ElevenLabs の API キーが利用できない場合に自動的に使用されます。

## 設定

TTS の設定は、`openclaw.json` 内の `messages.tts` 配下にあります。
完全なスキーマは [Gateway configuration](/gateway/configuration) を参照してください。
28. 完全なスキーマは [Gateway configuration](/gateway/configuration) にあります。

### 最小構成（有効化 + プロバイダー）

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

### OpenAI をプライマリ、ElevenLabs をフォールバックにする場合

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

### Edge TTS をプライマリにする場合（API キー不要）

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

### Edge TTS を無効化

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

### カスタム制限 + prefs パス

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

### 受信したボイスノートの後のみ音声で返信

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 長文返信の自動要約を無効化

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

その後、次を実行します：

```
/tts summary off
```

### フィールドに関する注記

- `auto`: 自動 TTS モード（`off`、`always`、`inbound`、`tagged`）。
  - `inbound` は、受信したボイスノートの後にのみ音声を送信します。
  - `tagged` は、返信に `[[tts]]` タグが含まれる場合のみ音声を送信します。
- `enabled`: レガシー トグル（doctor がこれを `auto` に移行します）。
- `mode`: `"final"`（デフォルト）または `"all"`（ツール／ブロックの返信を含む）。
- `provider`: `"elevenlabs"`、`"openai"`、または `"edge"`（フォールバックは自動）。
- `provider` が **未設定** の場合、OpenClaw は `openai`（キーがある場合）、次に `elevenlabs`（キーがある場合）、
  それ以外は `edge` を優先します。
- `summaryModel`: 自動要約用の任意の低コスト モデル。デフォルトは `agents.defaults.model.primary`。
  - `provider/model` または設定済みのモデル エイリアスを受け付けます。
- `modelOverrides`: モデルが TTS ディレクティブを出力することを許可（デフォルトでオン）。
- `maxTextLength`: TTS 入力のハード上限（文字数）。超過すると `/tts audio` が失敗します。 `/tts audio` を超えると失敗します。
- `timeoutMs`: リクエスト タイムアウト（ms）。
- `prefsPath`: ローカル prefs JSON パスを上書き（プロバイダー／制限／要約）。
- `apiKey` の値は、環境変数（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）にフォールバックします。
- `elevenlabs.baseUrl`: ElevenLabs API のベース URL を上書きします。
- `elevenlabs.voiceSettings`:
  - `stability`、`similarityBoost`、`style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0`（1.0 = 通常）
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2 文字の ISO 639-1（例: `en`、`de`）
- `elevenlabs.seed`: 整数 `0..4294967295`（ベストエフォートの決定性）
- `edge.enabled`: Edge TTS の使用を許可（デフォルト `true`、API キー不要）。
- `edge.voice`: Edge のニューラル音声名（例: `en-US-MichelleNeural`）。
- `edge.lang`: 言語コード（例: `en-US`）。
- `edge.outputFormat`: Edge の出力フォーマット（例: `audio-24khz-48kbitrate-mono-mp3`）。
  - 有効な値は Microsoft Speech の出力フォーマットを参照してください。すべてのフォーマットが Edge でサポートされるわけではありません。
- `edge.rate` / `edge.pitch` / `edge.volume`: パーセント文字列（例: `+10%`、`-5%`）。
- `edge.saveSubtitles`: 音声ファイルと並行して JSON 字幕を書き込みます。
- `edge.proxy`: Edge TTS リクエスト用のプロキシ URL。
- `edge.timeoutMs`: リクエスト タイムアウトの上書き（ms）。

## モデル駆動の上書き（デフォルトでオン）

デフォルトでは、モデルは単一の返信に対して TTS ディレクティブを出力 **できます**。
`messages.tts.auto` が `tagged` の場合、これらのディレクティブが音声生成をトリガーするために必須となります。
`messages.tts.auto` が `tagged` の場合、これらのディレクティブはオーディオをトリガーするのに必要です。

有効時、モデルは単一の返信に対して音声を上書きするための `[[tts:...]]` ディレクティブを出力でき、
さらにオプションで `[[tts:text]]...[[/tts:text]]` ブロックを使用して、
音声のみに含める表現タグ（笑い声、歌唱キューなど）を提供できます。

返信ペイロードの例：

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

利用可能なディレクティブ キー（有効時）：

- `provider`（`openai` | `elevenlabs` | `edge`）
- `voice`（OpenAI の音声）または `voiceId`（ElevenLabs）
- `model`（OpenAI TTS モデルまたは ElevenLabs のモデル ID）
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
- `applyTextNormalization`（`auto|on|off`）
- `languageCode`（ISO 639-1）
- `seed`

すべてのモデル上書きを無効化：

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

任意の許可リスト（タグを有効のまま、特定の上書きのみ無効化）：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## ユーザーごとの設定

スラッシュ コマンドは、ローカルの上書きを `prefsPath` に書き込みます（デフォルト:
`~/.openclaw/settings/tts.json`。`OPENCLAW_TTS_PREFS` または
`messages.tts.prefsPath` で上書き可能）。

保存されるフィールド：

- `enabled`
- `provider`
- `maxLength`（要約のしきい値。デフォルト 1500 文字）
- `summarize`（デフォルト `true`）

これらは、そのホストに対する `messages.tts.*` を上書きします。

## 出力フォーマット（固定）

- **Telegram**: Opus ボイスノート（ElevenLabs では `opus_48000_64`、OpenAI では `opus`）。
  - 48kHz / 64kbps は、ボイスノートとして適切なトレードオフであり、丸いバブル表示に必要です。
- **その他のチャンネル**: MP3（ElevenLabs では `mp3_44100_128`、OpenAI では `mp3`）。
  - 44.1kHz / 128kbps が音声明瞭度のデフォルト バランスです。
- **Edge TTS**: `edge.outputFormat` を使用（デフォルト `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` は `outputFormat` を受け付けますが、すべてのフォーマットが Edge サービスから利用できるわけではありません。citeturn2search0 <unk> cite<unk> turn2search0<unk>
  - 出力フォーマットの値は Microsoft Speech の出力フォーマットに従います（Ogg/WebM Opus を含む）。citeturn1search0 <unk> cite<unk> turn1search0<unk>
  - Telegram の `sendVoice` は OGG/MP3/M4A を受け付けます。保証された Opus ボイスノートが必要な場合は OpenAI/ElevenLabs を使用してください。citeturn1search1 <unk> cite<unk> turn1search1<unk>
  - 設定された Edge 出力フォーマットが失敗した場合、OpenClaw は MP3 で再試行します。

OpenAI/ElevenLabs のフォーマットは固定です。Telegram はボイスノート UX のために Opus を期待します。

## 自動 TTS の動作

有効時、OpenClaw は次を行います：

- 返信にすでにメディアまたは `MEDIA:` ディレクティブが含まれている場合、TTS をスキップします。
- 非常に短い返信（10 文字未満）をスキップします。
- 有効な場合、`agents.defaults.model.primary`（または `summaryModel`）を使用して長文返信を要約します。
- 生成された音声を返信に添付します。

返信が `maxLength` を超え、要約がオフ（または要約モデル用の API キーがない）場合、
音声はスキップされ、通常のテキスト返信が送信されます。

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

## スラッシュ コマンドの使用方法

コマンドは 1 つだけです: `/tts`。
有効化の詳細は [Slash commands](/tools/slash-commands) を参照してください。
有効化の詳細については、[Slash commands](/tools/slash-commands)を参照してください。

Discord の注記: `/tts` は Discord の組み込みコマンドのため、OpenClaw は
そこで `/voice` をネイティブ コマンドとして登録します。テキスト `/tts ...` も引き続き使用できます。 テキスト`/tts ...`はまだ動作します。

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

注記：

- コマンドには許可された送信者が必要です（許可リスト／オーナー ルールは引き続き適用されます）。
- `commands.text` またはネイティブ コマンド登録が有効である必要があります。
- `off|always|inbound|tagged` はセッションごとのトグルです（`/tts on` は `/tts always` のエイリアス）。
- `limit` および `summary` は、メイン設定ではなくローカル prefs に保存されます。
- `/tts audio` は単発の音声返信を生成します（TTS をオンには切り替えません）。

## エージェント ツール

`tts` ツールはテキストを音声に変換し、`MEDIA:` パスを返します。
結果が Telegram 互換の場合、このツールは `[[audio_as_voice]]` を含めるため、
Telegram はボイス バブルを送信します。
の結果がテレグラムと互換性がある場合、ツールは `[[audio_as_voice]]`を含むため、
テレグラムはボイスバブルを送信します。

## Gateway RPC

Gateway メソッド：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
