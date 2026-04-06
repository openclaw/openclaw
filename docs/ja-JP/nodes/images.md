---
read_when:
    - メディアパイプラインや添付ファイルを変更する場合
summary: 送信、Gateway ゲートウェイ、エージェント返信における画像・メディア処理ルール
title: 画像・メディアサポート
x-i18n:
    generated_at: "2026-04-02T07:45:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: aa16554ea65c073bfb166ee354e55fe0ca6460327b36c6a820999d11d38d835b
    source_path: nodes/images.md
    workflow: 15
---

# 画像・メディアサポート (2025-12-05)

WhatsApp チャネルは **Baileys Web** 経由で動作します。このドキュメントでは、送信、Gateway ゲートウェイ、およびエージェント返信における現在のメディア処理ルールをまとめています。

## 目標

- `openclaw message send --media` を使用して、オプションのキャプション付きでメディアを送信する。
- Web インボックスからの自動返信にテキストとともにメディアを含められるようにする。
- タイプごとの制限を合理的かつ予測可能に保つ。

## CLI インターフェース

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` はオプション。メディアのみの送信ではキャプションを空にできる。
  - `--dry-run` は解決済みペイロードを出力し、`--json` は `{ channel, to, messageId, mediaUrl, caption }` を出力する。

## WhatsApp Web チャネルの動作

- 入力: ローカルファイルパス **または** HTTP(S) URL。
- フロー: Buffer に読み込み、メディアの種類を検出し、適切なペイロードを構築する:
  - **画像:** JPEG にリサイズ・再圧縮（最大辺 2048px）し、`channels.whatsapp.mediaMaxMb`（デフォルト: 50 MB）を目標とする。
  - **音声/ボイス/動画:** 16 MB までパススルー。音声はボイスノート（`ptt: true`）として送信される。
  - **ドキュメント:** 上記以外すべて、最大 100 MB。利用可能な場合はファイル名が保持される。
- WhatsApp GIF スタイル再生: `gifPlayback: true`（CLI: `--gif-playback`）で MP4 を送信すると、モバイルクライアントでインラインループ再生される。
- MIME 検出はマジックバイトを優先し、次にヘッダー、次にファイル拡張子を使用する。
- キャプションは `--message` または `reply.text` から取得される。空のキャプションも許可される。
- ログ: 非 verbose モードでは `↩️`/`✅` を表示し、verbose モードではサイズとソースパス/URL を含む。

## 自動返信パイプライン

- `getReplyFromConfig` は `{ text?, mediaUrl?, mediaUrls? }` を返す。
- メディアが存在する場合、Web 送信側は `openclaw message send` と同じパイプラインを使用してローカルパスまたは URL を解決する。
- 複数のメディアエントリが指定された場合は順次送信される。

## 受信メディアからコマンドへ (Pi)

- 受信した Web メッセージにメディアが含まれている場合、OpenClaw は一時ファイルにダウンロードし、テンプレート変数を公開する:
  - `{{MediaUrl}}` 受信メディアの疑似 URL。
  - `{{MediaPath}}` コマンド実行前に書き込まれるローカル一時パス。
- セッションごとの Docker サンドボックスが有効な場合、受信メディアはサンドボックスワークスペースにコピーされ、`MediaPath`/`MediaUrl` は `media/inbound/<filename>` のような相対パスに書き換えられる。
- メディア理解（`tools.media.*` または共有 `tools.media.models` で設定されている場合）はテンプレート処理の前に実行され、`[Image]`、`[Audio]`、`[Video]` ブロックを `Body` に挿入できる。
  - 音声は `{{Transcript}}` を設定し、コマンド解析にトランスクリプトを使用するため、スラッシュコマンドも引き続き機能する。
  - 動画と画像の説明は、コマンド解析のためにキャプションテキストを保持する。
- デフォルトでは最初に一致した画像/音声/動画の添付ファイルのみが処理される。複数の添付ファイルを処理するには `tools.media.<cap>.attachments` を設定する。

## 制限とエラー

**送信キャップ（WhatsApp Web 送信）**

- 画像: 再圧縮後 `channels.whatsapp.mediaMaxMb`（デフォルト: 50 MB）まで。
- 音声/ボイス/動画: 16 MB 上限、ドキュメント: 100 MB 上限。
- サイズ超過または読み取り不能なメディア → ログに明確なエラーが記録され、返信はスキップされる。

**メディア理解キャップ（文字起こし/説明）**

- 画像デフォルト: 10 MB（`tools.media.image.maxBytes`）。
- 音声デフォルト: 20 MB（`tools.media.audio.maxBytes`）。
- 動画デフォルト: 50 MB（`tools.media.video.maxBytes`）。
- サイズ超過のメディアは理解処理がスキップされるが、返信は元の本文のまま送信される。

## テストに関する注意事項

- 画像/音声/ドキュメントの各ケースで送信と返信フローをカバーする。
- 画像の再圧縮（サイズ制限）と音声のボイスノートフラグを検証する。
- マルチメディア返信が順次送信として展開されることを確認する。
