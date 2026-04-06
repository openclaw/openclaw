---
read_when:
    - Skills 設定を追加または変更する
    - バンドルされた許可リストやインストール動作を調整する
summary: Skills 設定のスキーマと例
title: Skills 設定
x-i18n:
    generated_at: "2026-04-02T07:56:44Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a51f64d386a0b7c22486941b4075126f0080634452d4addc96b50a5065fc97cf
    source_path: tools/skills-config.md
    workflow: 15
---

# Skills 設定

Skills 関連の設定はすべて `~/.openclaw/openclaw.json` の `skills` 以下に配置されます。

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway ゲートウェイのランタイムは引き続き Node; bun は非推奨)
    },
    entries: {
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // またはプレーンテキスト文字列
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

組み込みの画像生成/編集には、`agents.defaults.imageGenerationModel` とコアの `image_generate` ツールの使用を推奨します。`skills.entries.*` はカスタムまたはサードパーティの Skills ワークフロー専用です。

特定の画像プロバイダー/モデルを選択した場合は、そのプロバイダーの認証/API キーも設定してください。一般的な例: `google/*` には `GEMINI_API_KEY` または `GOOGLE_API_KEY`、`openai/*` には `OPENAI_API_KEY`、`fal/*` には `FAL_KEY`。

例:

- ネイティブ Nano Banana スタイルのセットアップ: `agents.defaults.imageGenerationModel.primary: "google/gemini-3-pro-image-preview"`
- ネイティブ fal セットアップ: `agents.defaults.imageGenerationModel.primary: "fal/fal-ai/flux/dev"`

## フィールド

- 組み込みの Skills ルートには常に `~/.openclaw/skills`、`~/.agents/skills`、`<workspace>/.agents/skills`、`<workspace>/skills` が含まれます。
- `allowBundled`: **バンドルされた** Skills 専用のオプション許可リスト。設定すると、リスト内のバンドルされた Skills のみが対象になります（マネージド、エージェント、ワークスペースの Skills は影響を受けません）。
- `load.extraDirs`: スキャンする追加の Skills ディレクトリ（最低優先度）。
- `load.watch`: Skills フォルダを監視して Skills スナップショットを更新します（デフォルト: true）。
- `load.watchDebounceMs`: Skills ウォッチャーイベントのデバウンス（ミリ秒単位、デフォルト: 250）。
- `install.preferBrew`: 利用可能な場合、brew インストーラーを優先します（デフォルト: true）。
- `install.nodeManager`: node インストーラーの設定（`npm` | `pnpm` | `yarn` | `bun`、デフォルト: npm）。
  これは **Skills のインストール**にのみ影響します。Gateway ゲートウェイのランタイムは引き続き Node を使用してください（WhatsApp/Telegram では Bun は非推奨）。
- `entries.<skillKey>`: Skills ごとの上書き設定。

Skills ごとのフィールド:

- `enabled`: バンドル/インストール済みの Skills であっても無効にするには `false` に設定します。
- `env`: エージェント実行時に注入される環境変数（未設定の場合のみ）。
- `apiKey`: プライマリ環境変数を宣言する Skills 用のオプションの簡易設定。
  プレーンテキスト文字列または SecretRef オブジェクト（`{ source, provider, id }`）をサポートします。

## 注意事項

- `entries` 以下のキーは、デフォルトでは Skills 名にマッピングされます。Skills が `metadata.openclaw.skillKey` を定義している場合は、そのキーを使用してください。
- 読み込み優先度は `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → バンドルされた Skills → `skills.load.extraDirs` です。
- ウォッチャーが有効な場合、Skills への変更は次のエージェントターンで反映されます。

### サンドボックス化された Skills と環境変数

セッションが**サンドボックス化**されている場合、Skills プロセスは Docker 内で実行されます。サンドボックスはホストの `process.env` を**継承しません**。

次のいずれかを使用してください:

- `agents.defaults.sandbox.docker.env`（またはエージェントごとの `agents.list[].sandbox.docker.env`）
- カスタムサンドボックスイメージに環境変数を組み込む

グローバルな `env` および `skills.entries.<skill>.env/apiKey` は**ホスト**実行にのみ適用されます。
