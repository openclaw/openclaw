---
read_when:
    - エージェントを使って画像を生成する
    - 画像生成のプロバイダーとモデルを設定する
    - image_generate ツールのパラメータを理解する
summary: 設定済みのプロバイダー（OpenAI、Google Gemini、fal、MiniMax）を使用して画像を生成・編集する
title: 画像生成
x-i18n:
    generated_at: "2026-04-02T07:55:55Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a692ba1e5cdbefa58e702f2c2554867debf019f57e67c43c1237f2532383e959
    source_path: tools/image-generation.md
    workflow: 15
---

# 画像生成

`image_generate` ツールを使うと、設定済みのプロバイダーを利用してエージェントが画像を作成・編集できます。生成された画像は、エージェントの返信にメディア添付ファイルとして自動的に配信されます。

<Note>
このツールは、画像生成プロバイダーが少なくとも1つ利用可能な場合にのみ表示されます。エージェントのツール一覧に `image_generate` が表示されない場合は、`agents.defaults.imageGenerationModel` を設定するか、プロバイダーの API キーをセットアップしてください。
</Note>

## クイックスタート

1. 少なくとも1つのプロバイダーの API キーを設定します（例: `OPENAI_API_KEY` または `GEMINI_API_KEY`）。
2. 必要に応じて、使用するモデルを設定します:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: "openai/gpt-image-1",
    },
  },
}
```

3. エージェントに聞いてみましょう: _「フレンドリーなロブスターのマスコットの画像を生成して。」_

エージェントが自動的に `image_generate` を呼び出します。ツールの許可リストへの追加は不要です — プロバイダーが利用可能な場合、デフォルトで有効になっています。

## 対応プロバイダー

| プロバイダー | デフォルトモデル                 | 編集サポート            | API キー                             |
| ------------ | -------------------------------- | ----------------------- | ------------------------------------ |
| OpenAI       | `gpt-image-1`                    | なし                    | `OPENAI_API_KEY`                     |
| Google       | `gemini-3.1-flash-image-preview` | あり                    | `GEMINI_API_KEY` または `GOOGLE_API_KEY` |
| fal          | `fal-ai/flux/dev`                | あり                    | `FAL_KEY`                            |
| MiniMax      | `image-01`                       | あり（被写体参照）      | `MINIMAX_API_KEY`                    |

`action: "list"` を使用して、実行時に利用可能なプロバイダーとモデルを確認できます:

```
/tool image_generate action=list
```

## ツールパラメータ

| パラメータ    | 型       | 説明                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `prompt`      | string   | 画像生成プロンプト（`action: "generate"` の場合は必須）                               |
| `action`      | string   | `"generate"`（デフォルト）またはプロバイダーを確認する `"list"`                        |
| `model`       | string   | プロバイダー/モデルの上書き（例: `openai/gpt-image-1`）                               |
| `image`       | string   | 編集モード用の単一参照画像パスまたは URL                                              |
| `images`      | string[] | 編集モード用の複数参照画像（最大5枚）                                                 |
| `size`        | string   | サイズヒント: `1024x1024`、`1536x1024`、`1024x1536`、`1024x1792`、`1792x1024`         |
| `aspectRatio` | string   | アスペクト比: `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9` |
| `resolution`  | string   | 解像度ヒント: `1K`、`2K`、または `4K`                                                 |
| `count`       | number   | 生成する画像の枚数（1〜4）                                                            |
| `filename`    | string   | 出力ファイル名のヒント                                                                |

すべてのプロバイダーがすべてのパラメータに対応しているわけではありません。ツールは各プロバイダーがサポートするパラメータを渡し、残りは無視します。

## 設定

### モデル選択

```json5
{
  agents: {
    defaults: {
      // 文字列形式: プライマリモデルのみ
      imageGenerationModel: "google/gemini-3-pro-image-preview",

      // オブジェクト形式: プライマリ + 順序付きフォールバック
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
        fallbacks: ["google/gemini-3.1-flash-image-preview", "fal/fal-ai/flux/dev"],
      },
    },
  },
}
```

### プロバイダーの選択順序

画像を生成する際、OpenClaw は以下の順序でプロバイダーを試行します:

1. **ツール呼び出しの `model` パラメータ**（エージェントが指定した場合）
2. **設定の `imageGenerationModel.primary`**
3. **`imageGenerationModel.fallbacks`** を順番に試行
4. **自動検出** — 登録済みのすべてのプロバイダーにデフォルトを問い合わせ、設定済みのプライマリプロバイダー、次に OpenAI、次に Google、その他の順で優先

プロバイダーが失敗した場合（認証エラー、レート制限など）、次の候補が自動的に試行されます。すべて失敗した場合、エラーには各試行の詳細が含まれます。

### 画像編集

Google、fal、MiniMax は参照画像の編集をサポートしています。参照画像のパスまたは URL を渡してください:

```
"Generate a watercolor version of this photo" + image: "/path/to/photo.jpg"
```

Google は `images` パラメータで最大5枚の参照画像をサポートしています。fal と MiniMax は1枚をサポートしています。

## プロバイダーの機能

| 機能                  | OpenAI        | Google               | fal                 | MiniMax                    |
| --------------------- | ------------- | -------------------- | ------------------- | -------------------------- |
| 生成                  | あり（最大4枚） | あり（最大4枚）      | あり（最大4枚）     | あり（最大9枚）            |
| 編集/参照             | なし          | あり（最大5枚）      | あり（1枚）         | あり（1枚、被写体参照）    |
| サイズ制御            | あり          | あり                 | あり                | なし                       |
| アスペクト比          | なし          | あり                 | あり（生成のみ）    | あり                       |
| 解像度（1K/2K/4K）    | なし          | あり                 | あり                | なし                       |

## 関連項目

- [ツール概要](/tools) — 利用可能なすべてのエージェントツール
- [設定リファレンス](/gateway/configuration-reference#agent-defaults) — `imageGenerationModel` の設定
- [モデル](/concepts/models) — モデルの設定とフェイルオーバー
