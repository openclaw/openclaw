---
read_when:
    - macOS/iOS/Androidでトークモードを実装する場合
    - 音声/TTS/割り込み動作を変更する場合
summary: トークモード：ElevenLabs TTSによる連続音声会話
title: トークモード
x-i18n:
    generated_at: "2026-04-02T07:46:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 34ceb3669c5f9c166af6951ab8c6fcb0e626ed487de5cbe9449bcf9ba4aa12ac
    source_path: nodes/talk.md
    workflow: 15
---

# トークモード

トークモードは連続的な音声会話ループである：

1. 音声を検知する
2. 文字起こしをモデルに送信する（メインセッション、chat.send）
3. レスポンスを待つ
4. ElevenLabsで音声再生する（ストリーミング再生）

## 動作（macOS）

- トークモード有効中は**常時表示のオーバーレイ**。
- **リスニング → シンキング → スピーキング**のフェーズ遷移。
- **短い間**（無音ウィンドウ）で、現在の文字起こしが送信される。
- 返答は**WebChatに書き込まれる**（タイピングと同様）。
- **音声による割り込み**（デフォルトはオン）：アシスタントが話している間にユーザーが話し始めると、再生を停止し、次のプロンプトに割り込みのタイムスタンプを記録する。

## 返答内の音声ディレクティブ

アシスタントは返答の先頭に**単一のJSON行**を付けて音声を制御できる：

```json
{ "voice": "<voice-id>", "once": true }
```

ルール：

- 最初の空でない行のみ。
- 不明なキーは無視される。
- `once: true`は現在の返答にのみ適用される。
- `once`なしの場合、その音声がトークモードの新しいデフォルトになる。
- JSON行はTTS再生前に除去される。

サポートされるキー：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`、`rate`（WPM）、`stability`、`similarity`、`style`、`speakerBoost`
- `seed`、`normalize`、`lang`、`output_format`、`latency_tier`
- `once`

## 設定（`~/.openclaw/openclaw.json`）

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

デフォルト：

- `interruptOnSpeech`：true
- `silenceTimeoutMs`：未設定の場合、トークモードは文字起こしを送信する前にプラットフォームのデフォルトの間ウィンドウを使用する（`macOSおよびAndroidでは700 ms、iOSでは900 ms`）
- `voiceId`：`ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`にフォールバック（APIキーが利用可能な場合は最初のElevenLabs音声）
- `modelId`：未設定の場合、デフォルトは`eleven_v3`
- `apiKey`：`ELEVENLABS_API_KEY`にフォールバック（利用可能な場合はGateway ゲートウェイのシェルプロファイル）
- `outputFormat`：macOS/iOSではデフォルトは`pcm_44100`、Androidでは`pcm_24000`（MP3ストリーミングを強制するには`mp3_*`を設定）

## macOS UI

- メニューバートグル：**Talk**
- 設定タブ：**Talk Mode**グループ（音声ID + 割り込みトグル）
- オーバーレイ：
  - **リスニング**：マイクレベルに合わせて雲がパルスする
  - **シンキング**：沈むアニメーション
  - **スピーキング**：放射リング
  - 雲をクリック：音声再生を停止
  - Xをクリック：トークモードを終了

## 注意

- 音声認識 + マイクのパーミッションが必要。
- セッションキー`main`に対して`chat.send`を使用する。
- TTSはElevenLabsストリーミングAPIを`ELEVENLABS_API_KEY`と共に使用し、低レイテンシのためにmacOS/iOS/Androidでインクリメンタル再生を行う。
- `eleven_v3`の`stability`は`0.0`、`0.5`、`1.0`にバリデーションされる。他のモデルは`0..1`を受け付ける。
- `latency_tier`は設定時に`0..4`にバリデーションされる。
- Androidは低レイテンシのAudioTrackストリーミング用に`pcm_16000`、`pcm_22050`、`pcm_24000`、`pcm_44100`の出力フォーマットをサポートする。
