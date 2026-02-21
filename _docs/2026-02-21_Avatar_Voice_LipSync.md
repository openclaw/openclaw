# 2026-02-21: Avatar Voice and Lip Sync Integration

## 概要 (Overview)

ブラウザ上のFBXアバター表示環境（`scripts/avatar-window.html`）に対して、以下の機能を自律的かつインタラクティブに実行できるように拡張を行いました。

- PCの内蔵カメラによるPIP（Picture-in-Picture）表示
- ユーザー音声入力を取得する WebSpeech API (`webkitSpeechRecognition`) の導入
- OpenClaw GatewayへのWebSocket接続（音声認識テキストの送信）
- SBV2 TTSエンジンからの音声取得と Web Audio API による再生
- 音声のスペクトラム解析による、FBXの `Jaw` ボーンのリップシンク（口パク）アニメーション実装
- `*wave*` や `*nod*` といったアクションタグに応じた自律的なFBXアニメーションの再生設定

## 変更ファイル (Modified Files)

- `scripts/avatar-window.html`:
  - メニューUI（マイク・カメラのトグルボタン）と状態表示バッジを追加。
  - カメラ映像を `<video>` 要素で取得・表示処理を追加。
  - `webkitSpeechRecognition` による音声認識と、送信用 `sendToGateway` 関数を実装。
  - `AudioContext.createAnalyser()` など Web Audio API 関連の処理を追加。
  - `animate()` ループ内に `jawBone.rotation.x` を音量平均（0～255）に応じた値で補間させる処理を追加。

## テスト確認方法 (How to Verify)

1. `OpenClaw-All-In-One.bat` またはローカルのHTTPサーバー経由で対象のHTML（通常は3333番ポート）をブラウザで開く。
2. 画面下部の「Start Cam」「Start Mic」をクリックし、ブラウザのメディアデバイスの許可を付与する。
3. 話しかけるとテキストとして画面に表示され、バックグラウンドのGateway・LLMを経由して返答が生成される。
4. ボイス（TTS）が再生され、それに合わせてアバターの口（Jaw）が動くことを確認する。

## 今後の課題 (Future Considerations)

- OpenClaw Gatewayからの出力形式が `agent:message` のみで対応しているため、より複雑なツール利用（ストリーミング形式での音声応答対応など）にはさらなる調整が必要になる可能性があります。
- ボーン名が `"jaw"` を含むものを自動検索していますが、アバターのモデル仕様変更時には調整が必要です。
