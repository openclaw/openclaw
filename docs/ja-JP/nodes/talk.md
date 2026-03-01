---
summary: "トークモード: ElevenLabs TTS による連続音声会話"
read_when:
  - macOS/iOS/Android でのトークモードの実装
  - 音声/TTS/割り込み動作の変更
title: "トークモード"
---

# トークモード

トークモードは連続した音声会話ループです:

1. 音声をリッスンする
2. トランスクリプトをモデルに送信する（メインセッション、chat.send）
3. レスポンスを待つ
4. ElevenLabs を通じて発話する（ストリーミング再生）

## 動作（macOS）

- トークモードが有効な間、**常時表示のオーバーレイ**。
- **リッスン → 考え中 → 発話**のフェーズ遷移。
- **短い一時停止**（無音ウィンドウ）で現在のトランスクリプトが送信されます。
- 返信は**WebChat に書き込まれます**（タイプと同じ）。
- **音声での割り込み**（デフォルトでオン）: アシスタントが話している間にユーザーが話し始めた場合、再生を停止して次のプロンプトのために割り込みタイムスタンプを記録します。

## 返信での音声ディレクティブ

アシスタントは返信の最初に**単一の JSON 行**をプレフィックスとして付けて音声を制御できます:

```json
{ "voice": "<voice-id>", "once": true }
```

ルール:

- 最初の空でない行のみ。
- 不明なキーは無視されます。
- `once: true` は現在の返信のみに適用されます。
- `once` なしの場合、音声はトークモードの新しいデフォルトになります。
- TTS 再生前に JSON 行は取り除かれます。

サポートされているキー:

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
    interruptOnSpeech: true,
  },
}
```

デフォルト:

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` にフォールバック（または API キーが利用可能な場合は最初の ElevenLabs 音声）
- `modelId`: 未設定の場合は `eleven_v3` がデフォルト
- `apiKey`: `ELEVENLABS_API_KEY` にフォールバック（または利用可能な場合は Gateway のシェルプロファイル）
- `outputFormat`: macOS/iOS では `pcm_44100`、Android では `pcm_24000` がデフォルト（MP3 ストリーミングを強制するには `mp3_*` を設定）

## macOS UI

- メニューバートグル: **トーク**
- 設定タブ: **トークモード**グループ（音声 ID + 割り込みトグル）
- オーバーレイ:
  - **リッスン**: マイクレベルでクラウドがパルスする
  - **考え中**: 沈み込むアニメーション
  - **発話**: 放射状のリング
  - クラウドをクリック: 発話を停止
  - X をクリック: トークモードを終了

## 注意

- 音声 + マイクのパーミッションが必要です。
- セッションキー `main` に対して `chat.send` を使用します。
- TTS は `ELEVENLABS_API_KEY` を使用した ElevenLabs ストリーミング API を使用し、低レイテンシのために macOS/iOS/Android でインクリメンタル再生を行います。
- `eleven_v3` の `stability` は `0.0`、`0.5`、または `1.0` に検証されます。他のモデルは `0..1` を受け入れます。
- `latency_tier` は設定されている場合に `0..4` に検証されます。
- Android は低レイテンシの AudioTrack ストリーミングに `pcm_16000`、`pcm_22050`、`pcm_24000`、`pcm_44100` の出力フォーマットをサポートします。
