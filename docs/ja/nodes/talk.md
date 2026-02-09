---
summary: "Talk モード：ElevenLabs TTS による継続的な音声会話"
read_when:
  - macOS / iOS / Android で Talk モードを実装する場合
  - 音声 / TTS / 割り込みの挙動を変更する場合
title: "Talk モード"
---

# Talk モード

Talk モードは、継続的な音声会話ループです。

1. 音声をリッスン
2. 文字起こしをモデル（メイン セッション、chat.send）に送信
3. 応答を待機
4. ElevenLabs 経由で発話（ストリーミング再生）

## 挙動（macOS）

- Talk モードが有効な間、**常時表示オーバーレイ**。
- **Listening → Thinking → Speaking** のフェーズ遷移。
- **短いポーズ**（無音ウィンドウ）で、現在の文字起こしが送信されます。
- 応答は **WebChat に書き込まれます**（入力と同じ扱い）。
- **音声による割り込み**（デフォルト有効）：アシスタントの発話中にユーザーが話し始めた場合、再生を停止し、次のプロンプト用に割り込みのタイムスタンプを記録します。

## 応答内の音声ディレクティブ

アシスタントは、音声を制御するために **単一の JSON 行** を応答の先頭に付与できます。

```json
{ "voice": "<voice-id>", "once": true }
```

ルール：

- 最初の非空行のみが対象です。
- 不明なキーは無視されます。
- `once: true` は現在の応答のみに適用されます。
- `once` がない場合、その音声が Talk モードの新しいデフォルトになります。
- JSON 行は TTS 再生前に取り除かれます。

対応キー：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate`（WPM）, `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
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

デフォルト：

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` にフォールバック（または API キーが利用可能な場合は最初の ElevenLabs 音声）
- `modelId`: 未設定時は `eleven_v3` がデフォルト
- `apiKey`: `ELEVENLABS_API_KEY` にフォールバック（または利用可能な場合は ゲートウェイ のシェル プロファイル）
- `outputFormat`: macOS / iOS では `pcm_44100`、Android では `pcm_24000` がデフォルト（`mp3_*` を設定すると MP3 ストリーミングを強制）

## macOS UI

- メニューバー トグル：**Talk**
- 設定タブ：**Talk Mode** グループ（音声 ID + 割り込みトグル）
- オーバーレイ：
  - **Listening**：マイク レベルに応じて雲がパルス表示
  - **Thinking**：沈み込むアニメーション
  - **Speaking**：放射状のリング
  - 雲をクリック：発話を停止
  - X をクリック：Talk モードを終了

## 注記

- Speech および Microphone の権限が必要です。
- セッション キー `main` に対して `chat.send` を使用します。
- TTS は ElevenLabs のストリーミング API を使用し、`ELEVENLABS_API_KEY` と macOS / iOS / Android でのインクリメンタル再生により低レイテンシを実現します。
- `eleven_v3` 用の `stability` は `0.0`、`0.5`、または `1.0` に検証されます。その他のモデルは `0..1` を受け入れます。
- `latency_tier` は、設定時に `0..4` に検証されます。
- Android は、低レイテンシの AudioTrack ストリーミング向けに `pcm_16000`、`pcm_22050`、`pcm_24000`、および `pcm_44100` の出力フォーマットをサポートします。
