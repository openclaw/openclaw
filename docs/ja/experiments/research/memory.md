---
summary: "研究メモ: Clawd ワークスペース向けオフライン メモリ システム（Markdown を唯一の正とし、派生インデックスを生成）"
read_when:
  - 日次 Markdown ログを超えたワークスペース メモリ（~/.openclaw/workspace）の設計時
  - Deciding: スタンドアロン CLI と OpenClaw への深い統合の判断時
  - オフラインの想起 + 省察（retain/recall/reflect）の追加時
title: "ワークスペース メモリ 研究"
---

# Workspace Memory v2（オフライン）: 研究ノート

対象: Clawd スタイルのワークスペース（`agents.defaults.workspace`、既定は `~/.openclaw/workspace`）で、「メモリ」は 1 日 1 Markdown ファイル（`memory/YYYY-MM-DD.md`）と、少数の安定ファイル（例: `memory.md`、`SOUL.md`）として保存されます。

本ドキュメントは、Markdown をレビュー可能な正規の唯一の正としつつ、派生インデックスにより **構造化された想起**（検索、エンティティ要約、信頼度更新）を追加する **オフライン ファースト** のメモリ アーキテクチャを提案します。

## なぜ変更するのか？

現行の構成（1 日 1 ファイル）は、次に優れています。

- 「追記のみ」のジャーナリング
- 人手での編集
- Git による耐久性 + 監査性
- 低摩擦な記録（「とにかく書く」）

以下の条件で弱い：

- 高い再現率の検索（「X について何を決めたか？」「前回 Y を試したのはいつ？」）
- 多数のファイルを読み返さずに行うエンティティ中心の回答（「Alice / The Castle / warelay について教えて」）
- 意見・嗜好の安定性（および変更時の根拠）
- 時間制約（「2025 年 11 月時点で何が真だったか？」）と競合解決 紛争の解決

## 設計目標

- **オフライン**: ネットワーク不要。ノート PC / Castle で動作。クラウド依存なし。
- **説明可能**: 取得結果は帰属（ファイル + 位置）が明確で、推論と分離可能。
- **低儀式**: 日次ログは Markdown のまま。重いスキーマ作業は不要。
- **段階的**: v1 は FTS のみで有用。セマンティック / ベクター / グラフは任意の拡張。
- **エージェント フレンドリー**: 「トークン予算内での想起」を容易に（小さな事実バンドルを返す）。

## ノーススター モデル（Hindsight × Letta）

ブレンドする 2 要素:

1. **Letta / MemGPT スタイルの制御ループ**

- 小さな「コア」を常にコンテキストに保持（ペルソナ + 主要なユーザー事実）
- それ以外はコンテキスト外に置き、ツール経由で取得
- メモリ書き込みは明示的なツール呼び出し（append/replace/insert）として行い、永続化後、次ターンで再注入

2. **Hindsight スタイルのメモリ基盤**

- 観測されたもの / 信じられているもの / 要約されたものを分離
- retain / recall / reflect をサポート
- 証拠に基づいて進化する信頼度付きの意見
- エンティティ認識の取得 + 時系列クエリ（完全な知識グラフがなくても）

## 提案アーキテクチャ（Markdown を正とし、派生インデックスを生成）

### 正規ストア（Git フレンドリー）

人が読める正規のメモリとして `~/.openclaw/workspace` を保持します。

推奨ワークスペース構成:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

注記:

- **日次ログは日次ログのまま**。JSON にする必要はありません。 JSONに変換する必要はありません。
- `bank/` ファイルは **キュレーション済み** で、省察ジョブにより生成されますが、手動編集も可能です。
- `memory.md` は「小さく + コア寄り」のままにします。毎セッション Clawd に見せたい内容です。

### 派生ストア（機械的想起）

ワークスペース配下に派生インデックスを追加します（必ずしも Git 管理は不要）。

```
~/.openclaw/workspace/.memory/index.sqlite
```

バックエンド:

- 事実 + エンティティ リンク + 意見メタデータ用の SQLite スキーマ
- 語彙的想起のための SQLite **FTS5**（高速・小容量・オフライン）
- 任意でセマンティック想起用の埋め込みテーブル（オフライン）

このインデックスは常に **Markdown から再構築可能** です。

## Retain / Recall / Reflect（運用ループ）

### Retain: 日次ログを「事実」に正規化

ここで重要な Hindsight の洞察は、極小スニペットではなく **物語的で自己完結した事実** を保存することです。

`memory/YYYY-MM-DD.md` の実践ルール:

- 一日の終わり（または途中）に、`## Retain` セクションを追加し、2～5 個の箇条書きを記載します。各箇条書きは:
  - 物語的（ターンを跨ぐ文脈を保持）
  - 自己完結（後から単独で読んで理解できる）
  - タイプ + エンティティ言及でタグ付け

例:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

最小限のパース:

- タイプ接頭辞: `W`（world）、`B`（experience/biographical）、`O`（opinion）、`S`（observation/summary; 通常は生成）
- エンティティ: `@Peter`、`@warelay` など（スラッグは `bank/entities/*.md` にマップ）
- 意見の信頼度: `O(c=0.0..1.0)`（任意）

著者に考えさせたくない場合は、reflect ジョブがログ全体からこれらの箇条書きを推定できますが、明示的な `## Retain` セクションを持つことが最も簡単な「品質レバー」です。

### Recall: 派生インデックスに対するクエリ

想起は次をサポートすべきです。

- **語彙的**: 「正確な用語 / 名前 / コマンドを探す」（FTS5）
- **エンティティ**: 「X について教えて」（エンティティ ページ + エンティティ連結事実）
- **時系列**: 「11 月 27 日頃に何が起きたか」/「先週以降」
- **意見**: 「Peter は何を好むか？」（信頼度 + 根拠付き） (信頼性+エビデンス付き)

戻り値の形式はエージェントに優しく、引用元にする必要があります。

- `kind`（`world|experience|opinion|observation`）
- `timestamp`（元の日付、または抽出された時間範囲）
- `entities`（`["Peter","warelay"]`）
- `content`（物語的な事実）
- `source`（`memory/2025-11-27.md#L12` など）

### Reflect: 安定ページの生成 + 信念の更新

リフレクションはスケジュールされた仕事 (毎日またはハートビート) です。それは次のようになります。

- 最近の事実から `bank/entities/*.md`（エンティティ要約）を更新
- 強化 / 反証に基づき `bank/opinions.md` の信頼度を更新
- 任意で `memory.md`（「コア寄り」の永続事実）への編集提案

意見の進化（シンプルで説明可能）:

- 各意見は次を持ちます。
  - 文
  - 信頼度 `c ∈ [0,1]`
  - last_updated
  - 証拠リンク（支持 + 反証の事実 ID）
- 新しい事実が到着したら:
  - エンティティ重なり + 類似度（まず FTS、後に埋め込み）で候補意見を探索
  - 小さなデルタで信頼度を更新。大きな変化には強い反証 + 反復した証拠が必要

## CLI 統合: スタンドアロン vs 深い統合

推奨: **OpenClaw への深い統合**。ただし分離可能なコア ライブラリは維持します。

### なぜ OpenClaw に統合するのか？

- OpenClaw は既に次を把握しています。
  - ワークスペース パス（`agents.defaults.workspace`）
  - セッション モデル + ハートビート
  - ロギング + トラブルシューティングのパターン
- エージェント自身がツールを呼び出すようにします。
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### なぜライブラリは分けるのか？

- Gateway / ランタイムなしでメモリ ロジックをテスト可能にするため
- 他の文脈（ローカル スクリプト、将来のデスクトップ アプリなど）で再利用するため

形状:
メモリ ツール群は小さな CLI + ライブラリ層を想定していますが、これは探索的な位置付けです。

## 「S-Collide」/ SuCo: いつ使うべきか（研究）

「S-Collide」が **SuCo（Subspace Collision）** を指す場合、これは部分空間での学習 / 構造化された衝突を用いて、再現率とレイテンシのトレードオフを狙う ANN 検索手法です（論文: arXiv 2411.14754、2024 年）。

`~/.openclaw/workspace` に対する実践的な見解:

- SuCo から **始めない**。
- SQLite FTS +（任意で）単純な埋め込みから始める。即座に多くの UX 改善が得られます。
- 次の条件を満たした場合にのみ、SuCo / HNSW / ScaNN クラスの解決策を検討します。
  - コーパスは大きい(10/数十万のチャンク)
  - 総当たりの埋め込み検索が遅くなってきた
  - 語彙検索が再現率のボトルネックになっている

オフライン フレンドリーな代替（複雑度が低い順）:

- SQLite FTS5 + メタデータ フィルタ（ML なし）
- 埋め込み + ブルート力 (チャンク数が少ない場合、驚くほど遠くまで動作します)
- HNSW インデックス（一般的で堅牢。ライブラリ バインディングが必要）
- SuCo（研究グレード。組み込み可能な堅実な実装があれば魅力的）

未解決の問い:

- ノート PC + デスクトップで動かす「パーソナル アシスタント メモリ」に最適な **オフライン** 埋め込みモデルは何か？
  - 既に Ollama があるならローカル モデルで埋め込み。なければ小さな埋め込みモデルをツールチェーンに同梱。

## 最小で有用なパイロット

最小構成で、それでも有用にするなら:

- `bank/` のエンティティ ページと、日次ログ内の `## Retain` セクションを追加。
- 出典（パス + 行番号）付きで SQLite FTS による想起を使用。
- 再現率やスケールが要求された場合にのみ埋め込みを追加。

## 参考文献

- Letta / MemGPT の概念: 「コア メモリ ブロック」+「アーカイブ メモリ」+ ツール駆動の自己編集メモリ。
- Hindsight 技術レポート: 「retain / recall / reflect」、四層メモリ、物語的事実抽出、意見の信頼度進化。
- SuCo: arXiv 2411.14754（2024 年）: 「Subspace Collision」近似最近傍検索。
