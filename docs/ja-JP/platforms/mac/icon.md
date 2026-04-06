---
read_when:
    - メニューバーアイコンの動作を変更する場合
summary: macOSにおけるOpenClawのメニューバーアイコンの状態とアニメーション
title: メニューバーアイコン
x-i18n:
    generated_at: "2026-04-02T07:48:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a67a6e6bbdc2b611ba365d3be3dd83f9e24025d02366bc35ffcce9f0b121872b
    source_path: platforms/mac/icon.md
    workflow: 15
---

# メニューバーアイコンの状態

著者: steipete · 更新日: 2025-12-06 · スコープ: macOSアプリ（`apps/macos`）

- **アイドル:** 通常のアイコンアニメーション（まばたき、時折のウィグル）。
- **一時停止:** ステータスアイテムは `appearsDisabled` を使用し、動きなし。
- **音声トリガー（大きな耳）:** 音声ウェイク検出器がウェイクワードを検出すると `AppState.triggerVoiceEars(ttl: nil)` を呼び出し、発話をキャプチャしている間 `earBoostActive=true` を維持します。耳がスケールアップ（1.9倍）し、読みやすさのために円形の耳穴が表示され、1秒の無音後に `stopVoiceEars()` で元に戻ります。アプリ内の音声パイプラインからのみ発火します。
- **作業中（エージェント実行中）:** `AppState.isWorking=true` が「しっぽ/脚のスカリー」マイクロモーションを駆動します: 作業中は脚のウィグルが速くなり、わずかなオフセットが加わります。現在はWebChatのエージェント実行時にトグルされます。他の長時間タスクを接続する際にも同じトグルを追加してください。

接続ポイント

- 音声ウェイク: ランタイム/テスターがトリガー時に `AppState.triggerVoiceEars(ttl: nil)` を呼び出し、キャプチャウィンドウに合わせて1秒の無音後に `stopVoiceEars()` を呼び出します。
- エージェントアクティビティ: 作業スパンの前後で `AppStateStore.shared.setWorking(true/false)` を設定します（WebChatのエージェント呼び出しでは実装済み）。スパンは短く保ち、アニメーションが停止したままにならないよう `defer` ブロックでリセットしてください。

形状とサイズ

- ベースアイコンは `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` で描画されます。
- 耳のスケールはデフォルト `1.0`。音声ブーストでは `earScale=1.9` に設定し、`earHoles=true` をトグルしますが、全体のフレームは変更しません（18×18 ptテンプレート画像を36×36 px Retinaバッキングストアにレンダリング）。
- スカリーは脚のウィグルを最大約1.0まで使用し、小さな水平方向のジグルを伴います。既存のアイドルウィグルに加算されます。

動作に関する注意

- 耳/作業中の外部CLI/ブローカートグルはありません。意図しないフラッピングを避けるため、アプリ自身のシグナルに内部的に保持してください。
- ジョブがハングした場合にアイコンがすぐにベースラインに戻るよう、TTLは短く（10秒未満）保ってください。
