---
summary: "グローバルな音声ウェイクワード（Gateway 所有）と、それらがノード間でどのように同期されるか"
read_when:
  - 音声ウェイクワードの挙動やデフォルトを変更する場合
  - ウェイクワード同期が必要な新しいノードプラットフォームを追加する場合
title: "Voice Wake"
---

# Voice Wake（グローバル ウェイクワード）

OpenClaw では、**ウェイクワードは Gateway が所有する単一のグローバルリスト**として扱われます。

- **ノードごとのカスタム ウェイクワードはありません**。
- **任意のノード／アプリの UI から編集可能**で、変更は Gateway により永続化され、全体にブロードキャストされます。
- 各デバイスには引き続き、**Voice Wake の有効／無効**トグルが個別に存在します（ローカル UX や権限は異なります）。

## ストレージ（Gateway ホスト）

ウェイクワードは、ゲートウェイ マシン上の次の場所に保存されます。

- `~/.openclaw/settings/voicewake.json`

形式：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## プロトコル

### メソッド

- `voicewake.get` → `{ triggers: string[] }`
- パラメーター `{ triggers: string[] }` を伴う `voicewake.set` → `{ triggers: string[] }`

注記：

- トリガーは正規化されます(トリミングされ、空になっています)。 空のリストはデフォルトに戻ります。
- 安全性のため、上限（件数／長さ）が適用されます。

### イベント

- `voicewake.changed` ペイロード `{ triggers: string[] }`

受信者：

- すべての WebSocket クライアント（macOS アプリ、WebChat など）
- 接続されているすべてのノード（iOS／Android）。また、ノード接続時には初期の「現在の状態」としても送信されます。

## クライアントの挙動

### macOS アプリ

- グローバル リストを使用して `VoiceWakeRuntime` トリガーを制御します。
- Voice Wake 設定の「Trigger words」を編集すると `voicewake.set` を呼び出し、その後はブロードキャストによって他のクライアントとの同期を維持します。

### iOS ノード

- グローバル リストを `VoiceWakeManager` トリガー検出に使用します。
- 設定で Wake Words を編集すると `voicewake.set`（Gateway WS 経由）を呼び出し、ローカルのウェイクワード検出の応答性も維持します。

### Android ノード

- 設定に Wake Words エディターを公開します。
- Gateway WS 経由で `voicewake.set` を呼び出し、編集内容が全体に同期されるようにします。
