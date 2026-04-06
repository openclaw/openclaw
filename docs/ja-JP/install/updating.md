---
read_when:
    - OpenClawをアップデートする場合
    - アップデート後に何かが動かなくなった場合
summary: OpenClawを安全にアップデートする（グローバルインストールまたはソース）、およびロールバック方法
title: アップデート
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 82af5234c9a86c4d9bfb45e344467ff7ac347e1592debeef40b75a9972f7a928
    source_path: install/updating.md
    workflow: 15
---

# アップデート

OpenClawを最新の状態に保ちましょう。

## 推奨: `openclaw update`

最も手軽なアップデート方法です。インストールタイプ（npmまたはgit）を検出し、最新バージョンを取得し、`openclaw doctor`を実行してGateway ゲートウェイを再起動します。

```bash
openclaw update
```

チャネルを切り替えたり特定のバージョンを指定したりするには：

```bash
openclaw update --channel beta
openclaw update --tag main
openclaw update --dry-run   # 適用せずにプレビュー
```

チャネルのセマンティクスについては[開発チャネル](/install/development-channels)を参照してください。

## 代替方法: インストーラーを再実行

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

オンボーディングをスキップするには`--no-onboard`を追加してください。ソースインストールの場合は`--install-method git --no-onboard`を渡してください。

## 代替方法: 手動npmまたはpnpm

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## 自動アップデーター

自動アップデーターはデフォルトでオフです。`~/.openclaw/openclaw.json`で有効化：

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| チャネル | 動作                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| `stable` | `stableDelayHours`待機してから`stableJitterHours`全体の決定論的ジッターで適用（展開の分散）。                    |
| `beta`   | `betaCheckIntervalHours`ごとにチェック（デフォルト: 毎時）して即座に適用。                                        |
| `dev`    | 自動適用なし。手動で`openclaw update`を使用してください。                                                         |

Gateway ゲートウェイは起動時にアップデートのヒントもログに記録します（`update.checkOnStart: false`で無効化）。

## アップデート後

<Steps>

### doctorを実行

```bash
openclaw doctor
```

設定を移行し、DMポリシーを監査し、Gateway ゲートウェイの健全性を確認します。詳細: [Doctor](/gateway/doctor)

### Gateway ゲートウェイを再起動

```bash
openclaw gateway restart
```

### 確認

```bash
openclaw health
```

</Steps>

## ロールバック

### バージョンを固定（npm）

```bash
npm i -g openclaw@<version>
openclaw doctor
openclaw gateway restart
```

ヒント: `npm view openclaw version`で現在の公開バージョンを確認できます。

### コミットを固定（ソース）

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
openclaw gateway restart
```

最新に戻るには: `git checkout main && git pull`

## 詰まった場合

- もう一度`openclaw doctor`を実行して出力を注意深く読んでください。
- 確認: [トラブルシューティング](/gateway/troubleshooting)
- Discordで質問: [https://discord.gg/clawd](https://discord.gg/clawd)

## 関連

- [インストール概要](/install) -- すべてのインストール方法
- [Doctor](/gateway/doctor) -- アップデート後のヘルスチェック
- [移行](/install/migrating) -- メジャーバージョンの移行ガイド
