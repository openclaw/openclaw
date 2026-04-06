---
read_when:
    - OpenClawでMiniMaxモデルを使いたい
    - MiniMaxのセットアップ手順が必要
summary: OpenClawでMiniMaxモデルを使用する
title: MiniMax
x-i18n:
    generated_at: "2026-04-02T08:58:16Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1fdc547bc6bbeaeefcaef1d5580b58ffd95acdefdd4bef608b7467eb73b69289
    source_path: providers/minimax.md
    workflow: 15
---

# MiniMax

OpenClawのMiniMaxプロバイダーはデフォルトで**MiniMax M2.7**を使用する。

## モデルラインナップ

- `MiniMax-M2.7`: デフォルトのホスト型テキストモデル。
- `MiniMax-M2.7-highspeed`: 高速版M2.7テキストティア。
- `image-01`: 画像生成モデル（生成および画像から画像への編集）。

## 画像生成

MiniMaxプラグインは`image_generate`ツール用に`image-01`モデルを登録する。以下をサポートしている：

- アスペクト比制御付きの**テキストから画像の生成**。
- アスペクト比制御付きの**画像から画像への編集**（被写体参照）。
- サポートされるアスペクト比：`1:1`、`16:9`、`4:3`、`3:2`、`2:3`、`3:4`、`9:16`、`21:9`。

MiniMaxを画像生成に使用するには、画像生成プロバイダーとして設定する：

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "minimax/image-01" },
    },
  },
}
```

プラグインはテキストモデルと同じ`MINIMAX_API_KEY`またはOAuth認証を使用する。MiniMaxが既にセットアップ済みであれば、追加の設定は不要である。

## セットアップの選択

### MiniMax OAuth（Coding Plan）- 推奨

**最適な用途:** OAuth経由のMiniMax Coding Planによるクイックセットアップ、APIキー不要。

バンドルされたOAuthプラグインを有効にして認証する：

```bash
openclaw plugins enable minimax  # 既にロード済みの場合はスキップ
openclaw gateway restart  # ゲートウェイが既に実行中の場合は再起動
openclaw onboard --auth-choice minimax-portal
```

エンドポイントの選択を求められる：

- **Global** - 海外ユーザー（`api.minimax.io`）
- **CN** - 中国のユーザー（`api.minimaxi.com`）

詳細はOpenClawリポジトリ内のMiniMaxプラグインパッケージREADMEを参照。

### MiniMax M2.7（APIキー）

**最適な用途:** Anthropic互換APIによるホスト型MiniMax。

CLIで設定する：

- `openclaw configure`を実行する
- **Model/auth**を選択する
- **MiniMax**の認証オプションを選択する

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.7-highspeed",
            name: "MiniMax M2.7 Highspeed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.7をフォールバックとして使用（例）

**最適な用途:** 最強の最新世代モデルをプライマリとして使用し、MiniMax M2.7にフェイルオーバーする。
以下の例では具体的なプライマリとしてOpusを使用している。お好みの最新世代プライマリモデルに置き換えること。

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "primary" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
    },
  },
}
```

## `openclaw configure`での設定

JSONを直接編集せずに、対話型設定ウィザードでMiniMaxを設定する：

1. `openclaw configure`を実行する。
2. **Model/auth**を選択する。
3. **MiniMax**の認証オプションを選択する。
4. プロンプトが表示されたらデフォルトモデルを選択する。

## 設定オプション

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic`（Anthropic互換）を推奨。`https://api.minimax.io/v1`はOpenAI互換ペイロード用のオプション。
- `models.providers.minimax.api`: `anthropic-messages`を推奨。`openai-completions`はOpenAI互換ペイロード用のオプション。
- `models.providers.minimax.apiKey`: MiniMax APIキー（`MINIMAX_API_KEY`）。
- `models.providers.minimax.models`: `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost`を定義する。
- `agents.defaults.models`: 許可リストに追加したいモデルのエイリアスを設定する。
- `models.mode`: 組み込みモデルと並行してMiniMaxを追加する場合は`merge`のままにする。

## 注意事項

- モデル参照は`minimax/<model>`の形式。
- デフォルトテキストモデル：`MiniMax-M2.7`。
- 代替テキストモデル：`MiniMax-M2.7-highspeed`。
- Coding Plan使用量API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（Coding Planキーが必要）。
- 正確なコスト追跡が必要な場合は`models.json`の価格値を更新する。
- MiniMax Coding Planの紹介リンク（10%オフ）：[https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- プロバイダールールについては[/concepts/model-providers](/concepts/model-providers)を参照。
- `openclaw models list`および`openclaw models set minimax/MiniMax-M2.7`で切り替え可能。

## トラブルシューティング

### 「Unknown model: minimax/MiniMax-M2.7」

これは通常、**MiniMaxプロバイダーが設定されていない**（プロバイダーエントリがなく、MiniMax認証プロファイル／環境変数キーが見つからない）ことを意味する。この検出の修正は**2026.1.12**に含まれている。以下の方法で修正する：

- **2026.1.12**にアップグレードする（またはソースの`main`から実行する）、その後ゲートウェイを再起動する。
- `openclaw configure`を実行して**MiniMax**の認証オプションを選択する、または
- `models.providers.minimax`ブロックを手動で追加する、または
- `MINIMAX_API_KEY`（またはMiniMax認証プロファイル）を設定してプロバイダーが注入されるようにする。

モデルIDは**大文字小文字を区別する**ことに注意：

- `minimax/MiniMax-M2.7`
- `minimax/MiniMax-M2.7-highspeed`

以下のコマンドで再確認する：

```bash
openclaw models list
```
