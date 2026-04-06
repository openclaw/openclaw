---
read_when:
    - メモリの仕組みを理解したいとき
    - どのメモリファイルに書き込むべきか知りたいとき
summary: OpenClaw がセッションをまたいで情報を記憶する仕組み
title: メモリ概要
x-i18n:
    generated_at: "2026-04-02T07:37:46Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 73ae51d5617ca6448f502df2b4cb4fb0bed86f5d6dc5576737948c4286901db6
    source_path: concepts/memory.md
    workflow: 15
---

# メモリ概要

OpenClaw はエージェントのワークスペースに**プレーンな Markdown ファイル**を書き込むことで情報を記憶します。モデルはディスクに保存されたものだけを「記憶」します -- 隠れた状態はありません。

## 仕組み

エージェントにはメモリを保存する 2 つの場所があります：

- **`MEMORY.md`** -- 長期記憶。永続的な事実、好み、決定事項。すべてのダイレクトメッセージセッションの開始時に読み込まれます。
- **`memory/YYYY-MM-DD.md`** -- デイリーノート。継続的なコンテキストと観察。今日と昨日のノートが自動的に読み込まれます。

これらのファイルはエージェントワークスペース（デフォルト `~/.openclaw/workspace`）に保存されます。

<Tip>
エージェントに何かを覚えてほしい場合は、「TypeScript が好きだと覚えておいて」と伝えるだけです。適切なファイルに書き込みます。
</Tip>

## メモリツール

エージェントにはメモリを操作する 2 つのツールがあります：

- **`memory_search`** -- 元の表現と異なる場合でも、セマンティック検索で関連するノートを見つけます。
- **`memory_get`** -- 特定のメモリファイルまたは行範囲を読み取ります。

両方のツールは、アクティブなメモリプラグイン（デフォルト：`memory-core`）によって提供されます。

## メモリ検索

エンベディングプロバイダーが設定されている場合、`memory_search` は**ハイブリッド検索**を使用します -- ベクトル類似度（意味的な類似性）とキーワードマッチング（ID やコードシンボルなどの完全一致）を組み合わせます。サポートされているプロバイダーの API キーがあれば、すぐに動作します。

<Info>
OpenClaw は利用可能な API キーからエンベディングプロバイダーを自動検出します。OpenAI、Gemini、Voyage、または Mistral のキーが設定されている場合、メモリ検索は自動的に有効になります。
</Info>

検索の仕組み、チューニングオプション、プロバイダーのセットアップについての詳細は、[メモリ検索](/concepts/memory-search)を参照してください。

## メモリバックエンド

<CardGroup cols={3}>
<Card title="組み込み（デフォルト）" icon="database" href="/concepts/memory-builtin">
SQLite ベース。キーワード検索、ベクトル類似度、ハイブリッド検索がすぐに使えます。追加の依存関係は不要です。
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
リランキング、クエリ拡張、ワークスペース外のディレクトリのインデックス作成機能を備えたローカルファーストのサイドカー。
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
ユーザーモデリング、セマンティック検索、マルチエージェント対応を備えた AI ネイティブなクロスセッションメモリ。プラグインのインストールが必要です。
</Card>
</CardGroup>

## 自動メモリフラッシュ

[圧縮](/concepts/compaction)が会話を要約する前に、OpenClaw は重要なコンテキストをメモリファイルに保存するようエージェントに促すサイレントターンを実行します。これはデフォルトで有効です -- 設定は不要です。

<Tip>
メモリフラッシュは圧縮時のコンテキスト喪失を防ぎます。エージェントの会話にまだファイルに書き込まれていない重要な事実がある場合、要約が行われる前に自動的に保存されます。
</Tip>

## CLI

```bash
openclaw memory status          # インデックスの状態とプロバイダーを確認
openclaw memory search "query"  # コマンドラインから検索
openclaw memory index --force   # インデックスを再構築
```

## 関連情報

- [組み込みメモリエンジン](/concepts/memory-builtin) -- デフォルトの SQLite バックエンド
- [QMD メモリエンジン](/concepts/memory-qmd) -- 高度なローカルファーストのサイドカー
- [Honcho メモリ](/concepts/memory-honcho) -- AI ネイティブなクロスセッションメモリ
- [メモリ検索](/concepts/memory-search) -- 検索パイプライン、プロバイダー、チューニング
- [メモリ設定リファレンス](/reference/memory-config) -- すべての設定項目
- [圧縮](/concepts/compaction) -- 圧縮とメモリの相互作用
