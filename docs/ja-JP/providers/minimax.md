---
summary: "OpenClawでMiniMax M2.1を使用する"
read_when:
  - OpenClawでMiniMaxモデルを使いたい場合
  - MiniMaxのセットアップガイダンスが必要な場合
title: "MiniMax"
---

# MiniMax

MiniMaxはAI企業で、**M2/M2.1**モデルファミリーを開発しています。現在のコーディング重視リリースは**MiniMax M2.1**（2025年12月23日）で、現実世界の複雑なタスク向けに設計されています。

出典: [MiniMax M2.1リリースノート](https://www.minimax.io/news/minimax-m21)

## モデル概要（M2.1）

MiniMaxはM2.1での以下の改善点を挙げています:

- **マルチ言語コーディング**の強化（Rust、Java、Go、C++、Kotlin、Objective-C、TS/JS）。
- **ウェブ/アプリ開発**と見栄えの品質向上（ネイティブモバイルを含む）。
- インターリーブされた思考と統合された制約実行を活かした、オフィスワークフロー向けの**複合命令**処理の改善。
- トークン使用量の削減とより速い反復ループによる**より簡潔なレスポンス**。
- ツール/エージェントフレームワーク（Claude Code、Droid/Factory AI、Cline、Kilo Code、Roo Code、BlackBox）の互換性とコンテキスト管理の強化。
- より高品質な**対話と技術文書**の出力。

## MiniMax M2.1 と MiniMax M2.1 Lightning の比較

- **速度:** LightningはMiniMaxの料金ドキュメントにおける「高速」バリアントです。
- **コスト:** 料金表では同じ入力コストですが、Lightningは出力コストが高くなります。
- **コーディングプランのルーティング:** LightningバックエンドはMiniMaxコーディングプランでは直接利用できません。MiniMaxはほとんどのリクエストをLightningに自動ルーティングしますが、トラフィックの急増時は通常のM2.1バックエンドにフォールバックします。

## セットアップを選択する

### MiniMax OAuth（コーディングプラン）— 推奨

**適した用途:** OAuthによるMiniMaxコーディングプランのクイックセットアップ、APIキー不要。

バンドルされたOAuthプラグインを有効にして認証します:

```bash
openclaw plugins enable minimax-portal-auth  # すでにロード済みの場合はスキップ
openclaw gateway restart  # Gatewayがすでに実行中の場合は再起動
openclaw onboard --auth-choice minimax-portal
```

エンドポイントを選択するよう求められます:

- **Global** - 国際ユーザー（`api.minimax.io`）
- **CN** - 中国ユーザー（`api.minimaxi.com`）

詳細は [MiniMax OAuthプラグインREADME](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) を参照してください。

### MiniMax M2.1（APIキー）

**適した用途:** Anthropic互換APIによるホスト型MiniMax。

CLIで設定する:

- `openclaw configure` を実行
- **Model/auth** を選択
- **MiniMax M2.1** を選択

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### フォールバックとしてMiniMax M2.1（Opusがプライマリ）

**適した用途:** Opus 4.6をプライマリとして、MiniMax M2.1にフェイルオーバー。

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### オプション: LM Studio経由でローカル実行（手動）

**適した用途:** LM Studioによるローカル推論。
LM Studioのローカルサーバーを使用して、高性能なハードウェア（例: デスクトップ/サーバー）でMiniMax M2.1を使用した良好な結果が報告されています。

`openclaw.json` で手動設定する:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## `openclaw configure` で設定する

JSONを直接編集せずにインタラクティブな設定ウィザードでMiniMaxを設定します:

1. `openclaw configure` を実行します。
2. **Model/auth** を選択します。
3. **MiniMax M2.1** を選択します。
4. プロンプトが表示されたらデフォルトモデルを選択します。

## 設定オプション

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic`（Anthropic互換）を推奨。OpenAI互換ペイロードの場合は `https://api.minimax.io/v1` もオプションです。
- `models.providers.minimax.api`: `anthropic-messages` を推奨。OpenAI互換ペイロードの場合は `openai-completions` もオプションです。
- `models.providers.minimax.apiKey`: MiniMax APIキー（`MINIMAX_API_KEY`）。
- `models.providers.minimax.models`: `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost` を定義します。
- `agents.defaults.models`: 許可リストに含めるモデルをエイリアス設定します。
- `models.mode`: MiniMaxをビルトインに加えて追加する場合は `merge` を維持してください。

## 注意事項

- モデル参照は `minimax/<model>` の形式です。
- コーディングプランの使用状況API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（コーディングプランキーが必要）。
- 正確なコスト追跡が必要な場合は `models.json` の料金値を更新してください。
- MiniMaxコーディングプランの紹介リンク（10%割引）: [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- プロバイダールールについては [/concepts/model-providers](/concepts/model-providers) を参照してください。
- `openclaw models list` および `openclaw models set minimax/MiniMax-M2.1` を使ってモデルを切り替えます。

## トラブルシューティング

### 「Unknown model: minimax/MiniMax-M2.1」

これは通常、**MiniMaxプロバイダーが設定されていない**ことを意味します（プロバイダーエントリがなく、MiniMax認証プロファイル/環境キーが見つかりません）。この検出に対する修正は**2026.1.12**（執筆時点では未リリース）に含まれています。対処方法:

- **2026.1.12**にアップグレードする（またはソース `main` から実行する）、次にGatewayを再起動する。
- `openclaw configure` を実行して **MiniMax M2.1** を選択する、または
- `models.providers.minimax` ブロックを手動で追加する、または
- `MINIMAX_API_KEY`（またはMiniMax認証プロファイル）を設定してプロバイダーが注入されるようにする。

モデルIDは**大文字小文字を区別**することを確認してください:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

その後、以下で確認してください:

```bash
openclaw models list
```
