---
title: "Pi 開発ワークフロー"
summary: "Pi インテグレーションの開発者ワークフロー: ビルド、テスト、ライブ検証"
read_when:
  - Pi インテグレーションコードまたはテストに取り組む場合
  - Pi 固有の lint、型チェック、ライブテストフローを実行する場合
---

# Pi 開発ワークフロー

このガイドは、OpenClaw の Pi インテグレーションに取り組む際の合理的なワークフローをまとめたものです。

## 型チェックと Lint

- 型チェックとビルド: `pnpm build`
- Lint: `pnpm lint`
- フォーマットチェック: `pnpm format`
- プッシュ前の完全なゲート: `pnpm lint && pnpm build && pnpm test`

## Pi テストの実行

Vitest で Pi に焦点を当てたテストセットを直接実行します:

```bash
pnpm test -- \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-extensions/**/*.test.ts"
```

ライブプロバイダーのエクササイズを含める場合:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test -- src/agents/pi-embedded-runner-extraparams.live.test.ts
```

これは主な Pi ユニットスイートをカバーします:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 手動テスト

推奨フロー:

- 開発モードで Gateway を実行:
  - `pnpm gateway:dev`
- エージェントを直接起動:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- インタラクティブなデバッグに TUI を使用:
  - `pnpm tui`

ツール呼び出しの動作については、ツールストリーミングとペイロード処理を確認できるよう `read` または `exec` アクションをプロンプトしてください。

## クリーンスレートのリセット

状態は OpenClaw 状態ディレクトリの下にあります。デフォルトは `~/.openclaw` です。`OPENCLAW_STATE_DIR` が設定されている場合は、そのディレクトリを使用します。

すべてをリセットするには:

- コンフィグの `openclaw.json`
- 認証プロファイルとトークンの `credentials/`
- エージェントセッション履歴の `agents/<agentId>/sessions/`
- セッションインデックスの `agents/<agentId>/sessions.json`
- レガシーパスが存在する場合の `sessions/`
- ブランクのワークスペースが必要な場合の `workspace/`

セッションのみをリセットする場合は、そのエージェントの `agents/<agentId>/sessions/` と `agents/<agentId>/sessions.json` を削除してください。再認証したくない場合は `credentials/` を保持してください。

## 参考文献

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
