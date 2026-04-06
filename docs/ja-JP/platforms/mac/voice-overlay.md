---
read_when:
    - 音声オーバーレイの動作を調整する場合
summary: ウェイクワードとプッシュトゥトークが重複した場合の音声オーバーレイライフサイクル
title: 音声オーバーレイ
x-i18n:
    generated_at: "2026-04-02T08:34:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1efcc26ec05d2f421cb2cf462077d002381995b338d00db77d5fdba9b8d938b6
    source_path: platforms/mac/voice-overlay.md
    workflow: 15
---

# 音声オーバーレイ ライフサイクル（macOS）

対象読者: macOSアプリのコントリビューター。目的: ウェイクワードとプッシュトゥトークが重複した場合に、音声オーバーレイの動作を予測可能に保つ。

## 現在の意図

- ウェイクワードによりオーバーレイがすでに表示されている状態でユーザーがホットキーを押した場合、ホットキーセッションはリセットせずに既存のテキストを_引き継ぐ_。ホットキーが押されている間、オーバーレイは表示されたまま。ユーザーがキーを離すと、トリムされたテキストがあれば送信し、なければ閉じる。
- ウェイクワード単体の場合は無音検出時に自動送信する。プッシュトゥトークはキーを離した時点で即座に送信する。

## 実装済み（2025年12月9日）

- オーバーレイセッションはキャプチャごと（ウェイクワードまたはプッシュトゥトーク）にトークンを保持するようになった。トークンが一致しない場合、部分結果/最終結果/送信/閉じる/レベル更新は破棄され、古いコールバックが回避される。
- プッシュトゥトークは表示中のオーバーレイテキストをプレフィックスとして引き継ぐ（ウェイクオーバーレイ表示中にホットキーを押すと、テキストが保持され新しい音声が追記される）。最終トランスクリプトを最大1.5秒待ち、取得できない場合は現在のテキストにフォールバックする。
- チャイム/オーバーレイのログは `info` レベルで `voicewake.overlay`、`voicewake.ptt`、`voicewake.chime` カテゴリに出力される（セッション開始、部分結果、最終結果、送信、閉じる、チャイム理由）。

## 次のステップ

1. **VoiceSessionCoordinator（actor）**
   - 常に1つの `VoiceSession` のみを管理する。
   - API（トークンベース）: `beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 古いトークンを持つコールバックを破棄する（古い認識エンジンがオーバーレイを再表示するのを防止）。
2. **VoiceSession（model）**
   - フィールド: `token`、`source`（wakeWord|pushToTalk）、コミット済み/揮発テキスト、チャイムフラグ、タイマー（自動送信、アイドル）、`overlayMode`（display|editing|sending）、クールダウン期限。
3. **オーバーレイバインディング**
   - `VoiceSessionPublisher`（`ObservableObject`）がアクティブセッションをSwiftUIにミラーリングする。
   - `VoiceWakeOverlayView` はパブリッシャー経由でのみレンダリングし、グローバルシングルトンを直接変更しない。
   - オーバーレイのユーザーアクション（`sendNow`、`dismiss`、`edit`）はセッショントークンとともにコーディネーターにコールバックする。
4. **統一送信パス**
   - `endCapture` 時: トリムされたテキストが空 → 閉じる。それ以外 → `performSend(session:)`（送信チャイムを1回再生、転送、閉じる）。
   - プッシュトゥトーク: 遅延なし。ウェイクワード: 自動送信のためのオプション遅延あり。
   - プッシュトゥトーク終了後、ウェイクランタイムに短いクールダウンを適用し、ウェイクワードが即座に再トリガーされるのを防ぐ。
5. **ログ**
   - コーディネーターはサブシステム `ai.openclaw`、カテゴリ `voicewake.overlay` および `voicewake.chime` で `.info` ログを出力する。
   - 主要イベント: `session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## デバッグチェックリスト

- オーバーレイが消えない問題を再現する際にログをストリーミングする:

  ```bash
  sudo log stream --predicate 'subsystem == "ai.openclaw" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- アクティブなセッショントークンが1つだけであることを確認する。古いコールバックはコーディネーターによって破棄されるべきである。
- プッシュトゥトークのリリース時に必ずアクティブトークンで `endCapture` が呼ばれることを確認する。テキストが空の場合、チャイムや送信なしで `dismiss` が期待される。

## 移行手順（推奨）

1. `VoiceSessionCoordinator`、`VoiceSession`、`VoiceSessionPublisher` を追加する。
2. `VoiceWakeRuntime` をリファクタリングし、`VoiceWakeOverlayController` を直接操作する代わりにセッションの作成/更新/終了を行うようにする。
3. `VoicePushToTalk` をリファクタリングし、既存セッションを引き継ぎ、リリース時に `endCapture` を呼び出すようにする。ランタイムクールダウンを適用する。
4. `VoiceWakeOverlayController` をパブリッシャーに接続し、ランタイム/PTTからの直接呼び出しを削除する。
5. セッション引き継ぎ、クールダウン、空テキスト時の閉じる動作に対する統合テストを追加する。
