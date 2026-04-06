---
read_when:
    - セッションやチャネルをまたいで機能する永続メモリが必要なとき
    - AI を活用した記憶呼び出しやユーザーモデリングが必要なとき
summary: Honcho プラグインによる AI ネイティブなクロスセッションメモリ
title: Honcho メモリ
x-i18n:
    generated_at: "2026-04-02T07:37:25Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 83ae3561152519a23589f754e0625f1e49c43e38f85de07686b963170a6cf229
    source_path: concepts/memory-honcho.md
    workflow: 15
---

# Honcho メモリ

[Honcho](https://honcho.dev) は OpenClaw に AI ネイティブなメモリを追加します。会話を専用サービスに永続化し、時間の経過とともにユーザーモデルとエージェントモデルを構築することで、ワークスペースの Markdown ファイルを超えたクロスセッションコンテキストをエージェントに提供します。

## 提供する機能

- **クロスセッションメモリ** -- 会話はターンごとに永続化されるため、セッションのリセット、圧縮、チャネルの切り替えをまたいでコンテキストが引き継がれます。
- **ユーザーモデリング** -- Honcho は各ユーザー（好み、事実、コミュニケーションスタイル）およびエージェント（パーソナリティ、学習した行動）のプロファイルを維持します。
- **セマンティック検索** -- 現在のセッションだけでなく、過去の会話からの観測結果に対して検索します。
- **マルチエージェント対応** -- 親エージェントは生成したサブエージェントを自動的に追跡し、子セッションでは親がオブザーバーとして追加されます。

## 利用可能なツール

Honcho は会話中にエージェントが使用できるツールを登録します：

**データ取得（高速、LLM 呼び出しなし）：**

| ツール                        | 機能                                           |
| --------------------------- | ------------------------------------------------------ |
| `honcho_context`            | セッションをまたいだユーザーの完全な表現               |
| `honcho_search_conclusions` | 保存された結論に対するセマンティック検索                |
| `honcho_search_messages`    | セッションをまたいだメッセージ検索（送信者、日付でフィルタ） |
| `honcho_session`            | 現在のセッション履歴とサマリー                    |

**Q&A（LLM 駆動）：**

| ツール         | 機能                                                              |
| ------------ | ------------------------------------------------------------------------- |
| `honcho_ask` | ユーザーについて質問する。`depth='quick'` で事実確認、`'thorough'` で総合的な分析 |

## はじめに

プラグインをインストールしてセットアップを実行します：

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway --force
```

セットアップコマンドは API 認証情報の入力を求め、設定を書き込み、オプションで既存のワークスペースメモリファイルを移行します。

<Info>
Honcho は完全にローカル（セルフホスト）で実行することも、`api.honcho.dev` のマネージド API 経由で実行することもできます。セルフホストオプションの場合、外部依存関係は不要です。
</Info>

## 設定

設定は `plugins.entries["openclaw-honcho"].config` 配下にあります：

```json5
{
  plugins: {
    entries: {
      "openclaw-honcho": {
        config: {
          apiKey: "your-api-key", // セルフホストの場合は省略
          workspaceId: "openclaw", // メモリの分離
          baseUrl: "https://api.honcho.dev",
        },
      },
    },
  },
}
```

セルフホストインスタンスの場合は、`baseUrl` をローカルサーバー（例：`http://localhost:8000`）に指定し、API キーを省略してください。

## 既存メモリの移行

既存のワークスペースメモリファイル（`USER.md`、`MEMORY.md`、`IDENTITY.md`、`memory/`、`canvas/`）がある場合、`openclaw honcho setup` がそれらを検出し、移行を提案します。

<Info>
移行は非破壊的です -- ファイルは Honcho にアップロードされます。元のファイルは削除も移動もされません。
</Info>

## 仕組み

AI のターンごとに、会話は Honcho に永続化されます。ユーザーメッセージとエージェントメッセージの両方が観測され、Honcho は時間の経過とともにモデルを構築・改善します。

会話中、Honcho ツールは `before_prompt_build` フェーズでサービスに問い合わせを行い、モデルがプロンプトを見る前に関連するコンテキストを注入します。これにより、正確なターン境界と適切な記憶呼び出しが保証されます。

## Honcho と組み込みメモリの比較

|                   | 組み込み / QMD                | Honcho                              |
| ----------------- | ---------------------------- | ----------------------------------- |
| **ストレージ**       | ワークスペース Markdown ファイル     | 専用サービス（ローカルまたはホスト型） |
| **クロスセッション** | メモリファイル経由             | 自動、組み込み                 |
| **ユーザーモデリング** | 手動（MEMORY.md に書き込み）  | 自動プロファイル                  |
| **検索**        | ベクトル + キーワード（ハイブリッド）    | 観測結果に対するセマンティック検索          |
| **マルチエージェント**   | 追跡なし                  | 親子関係の認識              |
| **依存関係**  | なし（組み込み）または QMD バイナリ | プラグインのインストール                      |

Honcho と組み込みメモリシステムは併用できます。QMD が設定されている場合、Honcho のクロスセッションメモリとともにローカル Markdown ファイルを検索するための追加ツールが利用可能になります。

## CLI コマンド

```bash
openclaw honcho setup                        # API キーの設定とファイルの移行
openclaw honcho status                       # 接続状態の確認
openclaw honcho ask <question>               # ユーザーについて Honcho に問い合わせ
openclaw honcho search <query> [-k N] [-d D] # メモリに対するセマンティック検索
```

## 関連情報

- [プラグインソースコード](https://github.com/plastic-labs/openclaw-honcho)
- [Honcho ドキュメント](https://docs.honcho.dev)
- [Honcho OpenClaw 統合ガイド](https://docs.honcho.dev/v3/guides/integrations/openclaw)
- [メモリ](/concepts/memory) -- OpenClaw メモリの概要
- [コンテキストエンジン](/concepts/context-engine) -- プラグインコンテキストエンジンの仕組み
