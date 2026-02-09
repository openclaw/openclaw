---
summary: "OpenClaw で MiniMax M2.1 を使用します"
read_when:
  - OpenClaw で MiniMax モデルを使用したい場合
  - MiniMax のセットアップ手順が必要な場合
title: "MiniMax"
---

# MiniMax

MiniMax は **M2/M2.1** モデルファミリーを構築する AI 企業です。現在の
コーディング重視のリリースは **MiniMax M2.1**（2025 年 12 月 23 日）で、
実世界の複雑なタスク向けに設計されています。 現在の
コーディングに焦点を当てたリリースは **MiniMax M2.1** (2025年12月23日) で、
実際の複雑なタスク用に構築されています。

出典: [MiniMax M2.1 リリースノート](https://www.minimax.io/news/minimax-m21)

## モデル概要（M2.1）

MiniMax は M2.1 における以下の改善点を強調しています。

- **多言語コーディング**（Rust、Java、Go、C++、Kotlin、Objective-C、TS/JS）の強化。
- **Web/アプリ開発** と美的な出力品質の向上（ネイティブモバイルを含む）。
- 交互思考と統合された制約実行を基盤とした、オフィス系ワークフロー向けの
  **複合指示** 処理の改善。
- トークン使用量を抑え、反復ループを高速化する **より簡潔な応答**。
- **ツール/エージェント フレームワーク** との互換性およびコンテキスト管理の強化
  （Claude Code、Droid/Factory AI、Cline、Kilo Code、Roo Code、BlackBox）。
- **対話および技術文書作成** の出力品質向上。

## MiniMax M2.1 と MiniMax M2.1 Lightning の比較

- **速度:** Lightning は MiniMax の価格ドキュメントで「高速」バリアントとして位置付けられています。
- **コスト:** 入力コストは同一ですが、Lightning は出力コストが高くなります。
- **コーディングプランのルーティング:** Lightning のバックエンドは MiniMax の
  コーディングプランから直接は利用できません。MiniMax は大半のリクエストを
  Lightning に自動ルーティングしますが、トラフィックスパイク時には通常の
  M2.1 バックエンドにフォールバックします。 MiniMax は、ほとんどのリクエストを Lightning に自動的にルーティングしますが、トラフィックスパイクの際に
  通常の M2.1 バックエンドに戻ります。

## セットアップの選択

### MiniMax OAuth（Coding Plan）— 推奨

**最適:** OAuth 経由で MiniMax Coding Plan を使用するクイックセットアップ。API キーは不要です。

同梱の OAuth プラグインを有効化して認証します。

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

エンドポイントの選択を求められます。

- **Global** - 海外ユーザー（`api.minimax.io`）
- **CN** - 中国のユーザー（`api.minimaxi.com`）

詳細は [MiniMax OAuth プラグイン README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) を参照してください。

### MiniMax M2.1（API キー）

**最適:** Anthropic 互換 API を備えたホスト型 MiniMax。

CLI から設定します。

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

### MiniMax M2.1 をフォールバックとして使用（Opus を主系）

**最適:** Opus 4.6 を主系に維持し、MiniMax M2.1 にフェイルオーバーします。

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

### 任意: LM Studio 経由のローカル（手動）

**最適:** LMスタジオでのローカル推論。
**最適:** LM Studio を用いたローカル推論。
強力なハードウェア（例: デスクトップ/サーバー）で LM Studio のローカルサーバーを使用した
MiniMax M2.1 において、良好な結果を確認しています。

`openclaw.json` を使用して手動で設定します。

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

## `openclaw configure` による設定

JSON を編集せずに、対話型設定ウィザードを使用して MiniMax を設定します。

1. `openclaw configure` を実行します。
2. **Model/auth** を選択します。
3. **MiniMax M2.1** を選択します。
4. プロンプトに従って既定のモデルを選択します。

## 設定オプション

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic`（Anthropic 互換）を推奨。`https://api.minimax.io/v1` は OpenAI 互換ペイロード向けの任意項目です。
- `models.providers.minimax.api`: `anthropic-messages` を推奨。`openai-completions` は OpenAI 互換ペイロード向けの任意項目です。
- `models.providers.minimax.apiKey`: MiniMax API キー（`MINIMAX_API_KEY`）。
- `models.providers.minimax.models`: `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost` を定義します。
- `agents.defaults.models`: 許可リストに含めたいモデルのエイリアスを設定します。
- `models.mode`: 内蔵モデルと並行して MiniMax を追加する場合は `merge` を維持します。

## 注記

- モデル参照は `minimax/<model>` です。
- Coding Plan の使用量 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（コーディングプランのキーが必要）。
- 正確なコスト追跡が必要な場合は、`models.json` の価格値を更新してください。
- MiniMax Coding Plan の紹介リンク（10% 割引）: [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- プロバイダーのルールについては [/concepts/model-providers](/concepts/model-providers) を参照してください。
- 切り替えには `openclaw models list` と `openclaw models set minimax/MiniMax-M2.1` を使用します。

## トラブルシューティング

### 「Unknown model: minimax/MiniMax-M2.1」

これは通常、**MiniMax プロバイダーが設定されていない**（プロバイダーエントリーがなく、
MiniMax の認証プロファイル/環境キーも見つからない）ことを意味します。
この検出に対する修正は **2026.1.12** に含まれています（執筆時点では未リリース）。
以下の方法で対処してください。 この検出のための修正は、
**2026.1.12** (書き込み時に未リリース) にあります。 修正者：

- **2026.1.12** にアップグレード（またはソースから `main` を実行）し、ゲートウェイを再起動する。
- `openclaw configure` を実行して **MiniMax M2.1** を選択する、または
- `models.providers.minimax` ブロックを手動で追加する、または
- `MINIMAX_API_KEY`（または MiniMax の認証プロファイル）を設定して、プロバイダーを注入できるようにする。

モデル ID は **大文字小文字を区別** します。

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

その後、次で再確認してください。

```bash
openclaw models list
```
