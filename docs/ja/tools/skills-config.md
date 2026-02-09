---
summary: "Skills の設定スキーマと例"
read_when:
  - Skills の設定を追加または変更する場合
  - 同梱の許可リストやインストール動作を調整する場合
title: "Skills 設定"
---

# Skills 設定

すべての Skills 関連の設定は、`~/.openclaw/openclaw.json` の `skills` 配下にあります。

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
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
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

- `allowBundled`: **同梱** Skills のみに対する任意の許可リストです。設定されている場合、リスト内の同梱 Skills のみが対象になります（管理された／ワークスペースの Skills には影響しません）。 設定されている場合、リスト内の
  バンドルされたスキルのみが対象となります(管理スキル/ワークスペーススキルは影響を受けません)。
- `load.extraDirs`: スキャン対象とする追加の Skill ディレクトリ（優先度は最も低い）。
- `load.watch`: Skill フォルダーを監視し、Skills のスナップショットを更新します（デフォルト: true）。
- `load.watchDebounceMs`: Skill ウォッチャーのイベントに対するデバウンス（ミリ秒、デフォルト: 250）。
- `install.preferBrew`: 利用可能な場合に brew インストーラーを優先します（デフォルト: true）。
- `install.nodeManager`: Node インストーラーの優先設定（`npm` | `pnpm` | `yarn` | `bun`、デフォルト: npm）。
  これは **Skill のインストール** のみに影響します。Gateway ランタイムは引き続き Node を使用してください
  （WhatsApp/Telegram では Bun は推奨されません）。
  これは**スキルインストール**にのみ影響します。ゲートウェイランタイムはノード
  (WhatsApp/Telegramにはお勧めしません)。
- `entries.<skillKey>`: Skill ごとの上書き設定。

Skill ごとのフィールド:

- `enabled`: `false` を設定すると、同梱／インストール済みであっても Skill を無効化します。
- `env`: エージェント実行時に注入される環境変数（未設定の場合のみ）。
- `apiKey`: 主要な環境変数を宣言する Skills 向けの任意の利便機能です。

## 注記

- `entries`の下のキーは、デフォルトでスキル名にマップされます。 `entries` 配下のキーは、既定では Skill 名にマッピングされます。Skill が `metadata.openclaw.skillKey` を定義している場合は、そのキーを使用してください。
- ウォッチャーが有効な場合、Skills への変更は次回のエージェントのターンで反映されます。

### サンドボックス化された Skills と環境変数

セッションが **サンドボックス化** されている場合、Skill プロセスは Docker 内で実行されます。サンドボックスはホストの `process.env` を **継承しません**。 Sandbox
は `process.env` を継承しません。

次のいずれかを使用してください。

- `agents.defaults.sandbox.docker.env`（またはエージェントごとの `agents.list[].sandbox.docker.env`）
- カスタムのサンドボックスイメージに環境変数を焼き込む

グローバルな `env` および `skills.entries.<skill>.env/apiKey` は **ホスト** 実行にのみ適用されます。
