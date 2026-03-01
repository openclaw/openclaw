---
summary: "スキル設定のスキーマと例"
read_when:
  - スキル設定の追加または変更
  - バンドルされたアローリストまたはインストール動作の調整
title: "スキル設定"
---

# スキル設定

すべてのスキル関連の設定は `~/.openclaw/openclaw.json` の `skills` の下にあります。

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
      nodeManager: "npm", // npm | pnpm | yarn | bun（Gateway ランタイムは Node のまま; bun は非推奨）
    },
    entries: {
      "nano-banana-pro": {
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

## フィールド

- `allowBundled`: **バンドルされた**スキルのみのオプションのアローリスト。設定された場合、リスト内のバンドルされたスキルのみが対象になります（管理済み・ワークスペーススキルは影響を受けません）。
- `load.extraDirs`: スキャンする追加のスキルディレクトリ（最低優先度）。
- `load.watch`: スキルフォルダーを監視してスキルスナップショットを更新します（デフォルト: true）。
- `load.watchDebounceMs`: スキルウォッチャーイベントのデバウンス（ミリ秒、デフォルト: 250）。
- `install.preferBrew`: 利用可能な場合は brew インストーラーを優先します（デフォルト: true）。
- `install.nodeManager`: node インストーラーの優先設定（`npm` | `pnpm` | `yarn` | `bun`、デフォルト: npm）。
  これは**スキルインストール**のみに影響します。Gateway ランタイムは引き続き Node を使用してください
  （Bun は WhatsApp/Telegram には非推奨）。
- `entries.<skillKey>`: スキルごとのオーバーライド。

スキルごとのフィールド:

- `enabled`: `false` に設定すると、バンドル・インストール済みであってもスキルを無効化します。
- `env`: エージェント実行に注入される環境変数（まだ設定されていない場合のみ）。
- `apiKey`: プライマリ env 変数を宣言するスキルのためのオプションの便利な設定。
  プレーンテキスト文字列または SecretRef オブジェクト（`{ source, provider, id }`）をサポートします。

## 注意事項

- `entries` の下のキーはデフォルトでスキル名にマッピングされます。スキルが
  `metadata.openclaw.skillKey` を定義している場合は、代わりにそのキーを使用してください。
- ウォッチャーが有効な場合、スキルへの変更は次のエージェントターンで反映されます。

### サンドボックス化されたスキルと環境変数

セッションが**サンドボックス化されている**場合、スキルプロセスは Docker 内で実行されます。サンドボックスは
ホストの `process.env` を**継承しません**。

次のいずれかを使用してください:

- `agents.defaults.sandbox.docker.env`（またはエージェントごとの `agents.list[].sandbox.docker.env`）
- カスタムサンドボックスイメージに env を焼き込む

グローバルの `env` と `skills.entries.<skill>.env/apiKey` は**ホスト**実行にのみ適用されます。
