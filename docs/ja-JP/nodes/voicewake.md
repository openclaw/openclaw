---
read_when:
    - 音声ウェイクワードの動作やデフォルトを変更する場合
    - ウェイクワード同期が必要な新しいノードプラットフォームを追加する場合
summary: グローバル音声ウェイクワード（Gateway ゲートウェイ所有）とノード間での同期方法
title: Voice Wake
x-i18n:
    generated_at: "2026-04-02T07:46:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a80e0cf7f68a3d48ff79af0ffb3058a7a0ecebd2cdbaad20b9ff53bc2b39dc84
    source_path: nodes/voicewake.md
    workflow: 15
---

# Voice Wake（グローバルウェイクワード）

OpenClawは**ウェイクワードを単一のグローバルリスト**として扱い、**Gateway ゲートウェイ**が所有します。

- ノードごとのカスタムウェイクワードは**ありません**。
- **任意のノード/アプリUIがリストを編集**でき、変更はGateway ゲートウェイによって永続化され、全員にブロードキャストされます。
- macOSとiOSはローカルで**Voice Wakeの有効/無効**トグルを保持します（ローカルのUXと権限は異なります）。
- Androidは現在Voice Wakeをオフにしており、Voiceタブの手動マイクフローを使用します。

## ストレージ（Gateway ゲートウェイホスト）

ウェイクワードはGateway ゲートウェイマシンの以下のパスに保存されます:

- `~/.openclaw/settings/voicewake.json`

構造:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## プロトコル

### メソッド

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`（パラメータ `{ triggers: string[] }`）→ `{ triggers: string[] }`

注意:

- トリガーは正規化されます（トリミング、空文字の除去）。空リストはデフォルトにフォールバックします。
- 安全のため制限が適用されます（個数/長さの上限）。

### イベント

- `voicewake.changed` ペイロード `{ triggers: string[] }`

受信対象:

- すべてのWebSocketクライアント（macOSアプリ、WebChatなど）
- すべての接続済みノード（iOS/Android）。初回接続時にも「現在の状態」プッシュとして送信されます。

## クライアントの動作

### macOSアプリ

- グローバルリストを使用して `VoiceWakeRuntime` のトリガーをゲートします。
- Voice Wake設定で「トリガーワード」を編集すると `voicewake.set` が呼び出され、ブロードキャストにより他のクライアントと同期を保ちます。

### iOSノード

- グローバルリストを使用して `VoiceWakeManager` のトリガー検出を行います。
- 設定でWake Wordsを編集すると `voicewake.set`（Gateway ゲートウェイWSを経由）が呼び出され、ローカルのウェイクワード検出も即座に反映されます。

### Androidノード

- 現在、Androidのランタイム/設定ではVoice Wakeは無効です。
- Androidの音声機能は、ウェイクワードトリガーの代わりにVoiceタブの手動マイクキャプチャを使用します。
