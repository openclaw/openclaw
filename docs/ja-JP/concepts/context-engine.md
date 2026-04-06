---
read_when:
    - OpenClaw がモデルコンテキストをどのように組み立てるか理解したいとき
    - レガシーエンジンとプラグインエンジンの切り替えを行うとき
    - コンテキストエンジンプラグインを構築するとき
summary: 'コンテキストエンジン: プラグイン可能なコンテキスト組み立て、コンパクション、サブエージェントのライフサイクル'
title: コンテキストエンジン
x-i18n:
    generated_at: "2026-04-02T07:37:21Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 19fd8cbb0e953f58fd84637fc4ceefc65984312cf2896d338318bc8cf860e6d9
    source_path: concepts/context-engine.md
    workflow: 15
---

# コンテキストエンジン

**コンテキストエンジン**は、OpenClaw が各実行でモデルコンテキストをどのように構築するかを制御します。
どのメッセージを含めるか、古い履歴をどのように要約するか、サブエージェント境界を越えてコンテキストをどのように管理するかを決定します。

OpenClaw には組み込みの `legacy` エンジンが付属しています。プラグインは、アクティブなコンテキストエンジンのライフサイクルを置き換える代替エンジンを登録できます。

## クイックスタート

アクティブなエンジンを確認します:

```bash
openclaw doctor
# または設定を直接確認:
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### コンテキストエンジンプラグインのインストール

コンテキストエンジンプラグインは、他の OpenClaw プラグインと同様にインストールします。まずインストールしてから、スロットでエンジンを選択します:

```bash
# npm からインストール
openclaw plugins install @martian-engineering/lossless-claw

# またはローカルパスからインストール（開発用）
openclaw plugins install -l ./my-context-engine
```

次に、プラグインを有効にし、設定でアクティブなエンジンとして選択します:

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // プラグインの登録済みエンジン id と一致する必要があります
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // プラグイン固有の設定はここに記載します（プラグインのドキュメントを参照）
      },
    },
  },
}
```

インストールと設定の後、Gateway ゲートウェイを再起動してください。

組み込みエンジンに戻すには、`contextEngine` を `"legacy"` に設定します（またはキーを完全に削除します — デフォルトは `"legacy"` です）。

## 仕組み

OpenClaw がモデルプロンプトを実行するたびに、コンテキストエンジンは4つのライフサイクルポイントに関与します:

1. **Ingest** — 新しいメッセージがセッションに追加されたときに呼び出されます。エンジンは独自のデータストアにメッセージを保存またはインデックス化できます。
2. **Assemble** — 各モデル実行の前に呼び出されます。エンジンはトークン予算内に収まる順序付きメッセージセット（およびオプションの `systemPromptAddition`）を返します。
3. **Compact** — コンテキストウィンドウがいっぱいになったとき、またはユーザーが `/compact` を実行したときに呼び出されます。エンジンは古い履歴を要約してスペースを解放します。
4. **After turn** — 実行が完了した後に呼び出されます。エンジンは状態を永続化したり、バックグラウンドコンパクションをトリガーしたり、インデックスを更新したりできます。

### サブエージェントのライフサイクル（オプション）

OpenClaw は現在、1つのサブエージェントライフサイクルフックを呼び出します:

- **onSubagentEnded** — サブエージェントのセッションが完了またはスイープされたときにクリーンアップします。

`prepareSubagentSpawn` フックは将来の使用のためにインターフェースに含まれていますが、ランタイムはまだ呼び出しません。

### システムプロンプトの追加

`assemble` メソッドは `systemPromptAddition` 文字列を返すことができます。OpenClaw はこれを実行のシステムプロンプトの先頭に追加します。これにより、エンジンは静的なワークスペースファイルを必要とせずに、動的なリコールガイダンス、検索指示、またはコンテキストに応じたヒントを注入できます。

## レガシーエンジン

組み込みの `legacy` エンジンは OpenClaw の元の動作を保持します:

- **Ingest**: no-op（セッションマネージャーがメッセージの永続化を直接処理します）。
- **Assemble**: パススルー（ランタイムの既存のサニタイズ → 検証 → 制限パイプラインがコンテキスト組み立てを処理します）。
- **Compact**: 組み込みの要約コンパクションに委譲します。古いメッセージの単一の要約を作成し、最近のメッセージはそのまま保持します。
- **After turn**: no-op。

レガシーエンジンはツールを登録せず、`systemPromptAddition` も提供しません。

`plugins.slots.contextEngine` が設定されていない場合（または `"legacy"` に設定されている場合）、このエンジンが自動的に使用されます。

## プラグインエンジン

プラグインはプラグイン API を使用してコンテキストエンジンを登録できます:

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // メッセージをデータストアに保存
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      // 予算内に収まるメッセージを返す
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use lcm_grep to search history...",
      };
    },

    async compact({ sessionId, force }) {
      // 古いコンテキストを要約
      return { ok: true, compacted: true };
    },
  }));
}
```

次に設定で有効にします:

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

### ContextEngine インターフェース

必須メンバー:

| メンバー           | 種類     | 用途                                                     |
| ------------------ | -------- | -------------------------------------------------------- |
| `info`             | プロパティ | エンジンの id、名前、バージョン、およびコンパクションを所有するかどうか |
| `ingest(params)`   | メソッド   | 単一のメッセージを保存する                                 |
| `assemble(params)` | メソッド   | モデル実行用のコンテキストを構築する（`AssembleResult` を返す） |
| `compact(params)`  | メソッド   | コンテキストを要約/削減する                                |

`assemble` は以下を含む `AssembleResult` を返します:

- `messages` — モデルに送信する順序付きメッセージ。
- `estimatedTokens`（必須、`number`）— 組み立てられたコンテキストの合計トークン数のエンジン推定値。OpenClaw はこれをコンパクション閾値の判定と診断レポートに使用します。
- `systemPromptAddition`（オプション、`string`）— システムプロンプトの先頭に追加されます。

オプションメンバー:

| メンバー                         | 種類   | 用途                                                                                                             |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `bootstrap(params)`            | メソッド | セッションのエンジン状態を初期化する。エンジンがセッションを初めて認識したとき（例: 履歴のインポート）に一度呼び出される。 |
| `ingestBatch(params)`          | メソッド | 完了したターンをバッチとして取り込む。実行完了後、そのターンのすべてのメッセージをまとめて呼び出される。               |
| `afterTurn(params)`            | メソッド | 実行後のライフサイクル処理（状態の永続化、バックグラウンドコンパクションのトリガー）。                               |
| `prepareSubagentSpawn(params)` | メソッド | 子セッション用の共有状態をセットアップする。                                                                       |
| `onSubagentEnded(params)`      | メソッド | サブエージェント終了後にクリーンアップする。                                                                       |
| `dispose()`                    | メソッド | リソースを解放する。Gateway ゲートウェイのシャットダウンまたはプラグインのリロード時に呼び出される — セッションごとではない。 |

### ownsCompaction

`ownsCompaction` は、Pi の組み込みのインアテンプト自動コンパクションをその実行で有効のままにするかどうかを制御します:

- `true` — エンジンがコンパクション動作を所有します。OpenClaw はその実行で Pi の組み込み自動コンパクションを無効にし、エンジンの `compact()` 実装が `/compact`、オーバーフローリカバリーコンパクション、および `afterTurn()` で行いたいプロアクティブなコンパクションを担当します。
- `false` または未設定 — Pi の組み込み自動コンパクションはプロンプト実行中に引き続き動作する可能性がありますが、アクティブなエンジンの `compact()` メソッドは `/compact` とオーバーフローリカバリーに対して引き続き呼び出されます。

`ownsCompaction: false` は、OpenClaw が自動的にレガシーエンジンのコンパクションパスにフォールバックすることを意味**しません**。

つまり、有効なプラグインパターンは2つあります:

- **所有モード** — 独自のコンパクションアルゴリズムを実装し、`ownsCompaction: true` を設定します。
- **委譲モード** — `ownsCompaction: false` を設定し、`compact()` から `openclaw/plugin-sdk/core` の `delegateCompactionToRuntime(...)` を呼び出して OpenClaw の組み込みコンパクション動作を使用します。

no-op の `compact()` は、アクティブな非所有エンジンにとって安全ではありません。そのエンジンスロットの通常の `/compact` およびオーバーフローリカバリーコンパクションパスが無効になるためです。

## 設定リファレンス

```json5
{
  plugins: {
    slots: {
      // アクティブなコンテキストエンジンを選択。デフォルト: "legacy"。
      // プラグインエンジンを使用するにはプラグイン id を設定します。
      contextEngine: "legacy",
    },
  },
}
```

スロットは実行時に排他的です — 特定の実行またはコンパクション操作に対して、登録済みのコンテキストエンジンは1つだけ解決されます。他の有効な `kind: "context-engine"` プラグインは引き続きロードされ、登録コードを実行できます。`plugins.slots.contextEngine` は、OpenClaw がコンテキストエンジンを必要とするときに解決する登録済みエンジン id を選択するだけです。

## コンパクションとメモリとの関係

- **コンパクション**はコンテキストエンジンの責務の1つです。レガシーエンジンは OpenClaw の組み込み要約に委譲します。プラグインエンジンは任意のコンパクション戦略（DAG 要約、ベクトル検索など）を実装できます。
- **メモリプラグイン**（`plugins.slots.memory`）はコンテキストエンジンとは別のものです。メモリプラグインは検索/取得を提供し、コンテキストエンジンはモデルが何を見るかを制御します。これらは連携できます — コンテキストエンジンは組み立て時にメモリプラグインのデータを使用する場合があります。
- **セッションプルーニング**（古いツール結果のメモリ内トリミング）は、どのコンテキストエンジンがアクティブかに関係なく実行されます。

## ヒント

- `openclaw doctor` を使用して、エンジンが正しく読み込まれていることを確認してください。
- エンジンを切り替える場合、既存のセッションは現在の履歴で継続します。新しいエンジンは今後の実行から引き継ぎます。
- エンジンエラーはログに記録され、診断で表示されます。プラグインエンジンが登録に失敗した場合、または選択されたエンジン id が解決できない場合、OpenClaw は自動的にフォールバックしません。プラグインを修正するか `plugins.slots.contextEngine` を `"legacy"` に戻すまで、実行は失敗します。
- 開発用には、`openclaw plugins install -l ./my-engine` を使用して、コピーせずにローカルプラグインディレクトリをリンクしてください。

関連項目: [コンパクション](/concepts/compaction)、[コンテキスト](/concepts/context)、[プラグイン](/tools/plugin)、[プラグインマニフェスト](/plugins/manifest)。

## 関連

- [コンテキスト](/concepts/context) — エージェントのターンでコンテキストがどのように構築されるか
- [プラグインアーキテクチャ](/plugins/architecture) — コンテキストエンジンプラグインの登録
- [コンパクション](/concepts/compaction) — 長い会話の要約
