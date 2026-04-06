---
read_when:
    - Pi統合のコードやテストを作業する場合
    - Pi固有のlint、型チェック、ライブテストフローを実行する場合
summary: 'Pi統合の開発ワークフロー: ビルド、テスト、ライブ検証'
title: Pi開発ワークフロー
x-i18n:
    generated_at: "2026-04-02T07:46:39Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7be1c0f9ecf4315115b2e8188f7472eebba2a8424296661184a02bf5ad6e90c5
    source_path: pi-dev.md
    workflow: 15
---

# Pi開発ワークフロー

このガイドは、OpenClawにおけるPi統合の作業に関する合理的なワークフローをまとめたものです。

## 型チェックとリント

- 型チェックとビルド: `pnpm build`
- リント: `pnpm lint`
- フォーマットチェック: `pnpm format`
- プッシュ前の完全なゲート: `pnpm lint && pnpm build && pnpm test`

## Piテストの実行

Vitestを使用してPi関連のテストセットを直接実行します:

```bash
pnpm test -- \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-hooks/**/*.test.ts"
```

ライブプロバイダーテストを含める場合:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test -- src/agents/pi-embedded-runner-extraparams.live.test.ts
```

主なPiユニットテストスイートは以下の通りです:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-hooks/*.test.ts`

## 手動テスト

推奨フロー:

- 開発モードでGateway ゲートウェイを実行:
  - `pnpm gateway:dev`
- エージェントを直接トリガー:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 対話的なデバッグにTUIを使用:
  - `pnpm tui`

ツール呼び出しの動作を確認するには、`read` や `exec` アクションをプロンプトして、ツールのストリーミングやペイロード処理を確認できます。

## クリーンスレートリセット

状態はOpenClawのステートディレクトリに保存されます。デフォルトは `~/.openclaw` です。`OPENCLAW_STATE_DIR` が設定されている場合は、そのディレクトリを使用します。

すべてをリセットするには:

- `openclaw.json` — 設定
- `credentials/` — 認証プロファイルとトークン
- `agents/<agentId>/sessions/` — エージェントのセッション履歴
- `agents/<agentId>/sessions.json` — セッションインデックス
- `sessions/` — レガシーパスが存在する場合
- `workspace/` — ワークスペースを空にしたい場合

セッションのみをリセットしたい場合は、該当エージェントの `agents/<agentId>/sessions/` と `agents/<agentId>/sessions.json` を削除してください。再認証を避けたい場合は `credentials/` を残してください。

## 参考資料

- [テスト](/help/testing)
- [はじめに](/start/getting-started)
