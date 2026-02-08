---
summary: "ウェイクワードとプッシュトゥトークが重なった場合の音声オーバーレイのライフサイクル"
read_when:
  - 音声オーバーレイの挙動を調整する場合
title: "音声オーバーレイ"
x-i18n:
  source_path: platforms/mac/voice-overlay.md
  source_hash: 5d32704c412295c2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:46Z
---

# 音声オーバーレイのライフサイクル（macOS）

対象読者：macOS アプリのコントリビューター。目的：ウェイクワードとプッシュトゥトークが重なった際にも、音声オーバーレイを予測可能に保つこと。

## 現在の意図

- ウェイクワードによってすでにオーバーレイが表示されている状態でユーザーがホットキーを押した場合、ホットキーのセッションは既存のテキストをリセットせずに「採用」します。ホットキーが押されている間、オーバーレイは表示されたままになります。ユーザーが離したとき、トリム後のテキストがあれば送信し、なければ破棄します。
- ウェイクワードのみの場合は無音検出で自動送信され、プッシュトゥトークはリリース時に即時送信されます。

## 実装済み（2025 年 12 月 9 日）

- オーバーレイのセッションは、キャプチャ（ウェイクワードまたはプッシュトゥトーク）ごとにトークンを持つようになりました。トークンが一致しない場合、partial/final/send/dismiss/level の更新は破棄され、古いコールバックを回避します。
- プッシュトゥトークは、表示中のオーバーレイテキストをプレフィックスとして採用します（つまり、ウェイクオーバーレイが表示中にホットキーを押すと、テキストを保持したまま新しい音声が追記されます）。最終トランスクリプトを最大 1.5 秒待ち、それまでに得られない場合は現在のテキストにフォールバックします。
- チャイム／オーバーレイのログは `info` に、カテゴリ `voicewake.overlay`、`voicewake.ptt`、`voicewake.chime`（セッション開始、partial、final、send、dismiss、チャイム理由）として出力されます。

## 次のステップ

1. **VoiceSessionCoordinator（actor）**
   - 同時に正確に 1 つの `VoiceSession` を所有します。
   - API（トークンベース）：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 古いトークンを持つコールバックを破棄します（古い認識器がオーバーレイを再表示するのを防止）。
2. **VoiceSession（モデル）**
   - フィールド：`token`、`source`（wakeWord|pushToTalk）、確定／一時テキスト、チャイムフラグ、タイマー（自動送信、アイドル）、`overlayMode`（display|editing|sending）、クールダウン期限。
3. **オーバーレイのバインディング**
   - `VoiceSessionPublisher`（`ObservableObject`）が、アクティブなセッションを SwiftUI にミラーします。
   - `VoiceWakeOverlayView` はパブリッシャー経由でのみ描画し、グローバルなシングルトンを直接変更しません。
   - オーバーレイのユーザー操作（`sendNow`、`dismiss`、`edit`）は、セッショントークンを付けてコーディネーターへコールバックします。
4. **統一された送信パス**
   - `endCapture` 時：トリム後のテキストが空の場合 → 破棄。そうでなければ `performSend(session:)`（送信チャイムを 1 回再生し、転送して破棄）。
   - プッシュトゥトーク：遅延なし。ウェイクワード：自動送信のための任意の遅延。
   - プッシュトゥトーク終了後、ウェイクのランタイムに短いクールダウンを適用し、ウェイクワードが直ちに再トリガーされないようにします。
5. **ロギング**
   - コーディネーターは、サブシステム `bot.molt`、カテゴリ `voicewake.overlay` と `voicewake.chime` に `.info` のログを出力します。
   - 主要イベント：`session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## デバッグチェックリスト

- スティッキーなオーバーレイを再現しながらログをストリーミングします：

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- アクティブなセッショントークンが 1 つだけであることを確認します。古いコールバックはコーディネーターによって破棄されるはずです。
- プッシュトゥトークのリリース時に、必ずアクティブなトークンで `endCapture` が呼ばれることを確認します。テキストが空の場合、チャイムや送信なしで `dismiss` が発生する想定です。

## 移行手順（推奨）

1. `VoiceSessionCoordinator`、`VoiceSession`、`VoiceSessionPublisher` を追加します。
2. `VoiceWakeRuntime` をリファクタリングし、`VoiceWakeOverlayController` を直接操作するのではなく、セッションの作成／更新／終了を行うようにします。
3. `VoicePushToTalk` をリファクタリングして既存セッションを採用し、リリース時に `endCapture` を呼び出します。ランタイムのクールダウンを適用します。
4. `VoiceWakeOverlayController` をパブリッシャーに接続し、ランタイム／PTT からの直接呼び出しを削除します。
5. セッション採用、クールダウン、空テキスト破棄についての統合テストを追加します。
