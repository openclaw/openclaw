---
read_when:
    - 新しいモデルプロバイダープラグインを構築する場合
    - OpenAI互換プロキシやカスタムLLMをOpenClawに追加したい場合
    - プロバイダーの認証、カタログ、ランタイムフックを理解する必要がある場合
sidebarTitle: Provider Plugins
summary: OpenClawのモデルプロバイダープラグインを構築するためのステップバイステップガイド
title: プロバイダープラグインの構築
x-i18n:
    generated_at: "2026-04-02T08:37:27Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c21de26897f3adf5e2023a60a91c1b829ded60dfe72bb44b05e65116c468b688
    source_path: plugins/sdk-provider-plugins.md
    workflow: 15
---

# プロバイダープラグインの構築

このガイドでは、OpenClawにモデルプロバイダー（LLM）を追加するプロバイダープラグインの構築手順を説明します。最終的に、モデルカタログ、APIキー認証、動的モデル解決を備えたプロバイダーが完成します。

<Info>
  OpenClawプラグインを初めて構築する場合は、まず[はじめに](/plugins/building-plugins)を読んで、基本的なパッケージ構造とマニフェストのセットアップを理解してください。
</Info>

## ウォークスルー

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="パッケージとマニフェスト">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-ai",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["acme-ai"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme AI model provider",
      "providers": ["acme-ai"],
      "providerAuthEnvVars": {
        "acme-ai": ["ACME_AI_API_KEY"]
      },
      "providerAuthChoices": [
        {
          "provider": "acme-ai",
          "method": "api-key",
          "choiceId": "acme-ai-api-key",
          "choiceLabel": "Acme AI API key",
          "groupId": "acme-ai",
          "groupLabel": "Acme AI",
          "cliFlag": "--acme-ai-api-key",
          "cliOption": "--acme-ai-api-key <key>",
          "cliDescription": "Acme AI API key"
        }
      ],
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    マニフェストで`providerAuthEnvVars`を宣言することで、OpenClawはプラグインのランタイムを読み込まずに認証情報を検出できます。プロバイダーをClawHubで公開する場合、`package.json`の`openclaw.compat`と`openclaw.build`フィールドは必須です。

  </Step>

  <Step title="プロバイダーの登録">
    最小限のプロバイダーには`id`、`label`、`auth`、`catalog`が必要です：

    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

    export default definePluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      register(api) {
        api.registerProvider({
          id: "acme-ai",
          label: "Acme AI",
          docsPath: "/providers/acme-ai",
          envVars: ["ACME_AI_API_KEY"],

          auth: [
            createProviderApiKeyAuthMethod({
              providerId: "acme-ai",
              methodId: "api-key",
              label: "Acme AI API key",
              hint: "API key from your Acme AI dashboard",
              optionKey: "acmeAiApiKey",
              flagName: "--acme-ai-api-key",
              envVar: "ACME_AI_API_KEY",
              promptMessage: "Enter your Acme AI API key",
              defaultModel: "acme-ai/acme-large",
            }),
          ],

          catalog: {
            order: "simple",
            run: async (ctx) => {
              const apiKey =
                ctx.resolveProviderApiKey("acme-ai").apiKey;
              if (!apiKey) return null;
              return {
                provider: {
                  baseUrl: "https://api.acme-ai.com/v1",
                  apiKey,
                  api: "openai-completions",
                  models: [
                    {
                      id: "acme-large",
                      name: "Acme Large",
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                      contextWindow: 200000,
                      maxTokens: 32768,
                    },
                    {
                      id: "acme-small",
                      name: "Acme Small",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                      contextWindow: 128000,
                      maxTokens: 8192,
                    },
                  ],
                },
              };
            },
          },
        });
      },
    });
    ```

    これで動作するプロバイダーの完成です。ユーザーは`openclaw onboard --acme-ai-api-key <key>`を実行し、モデルとして`acme-ai/acme-large`を選択できるようになります。

    APIキー認証と単一のカタログベースランタイムでテキストプロバイダーを1つだけ登録するバンドルプロバイダーの場合は、よりシンプルな`defineSingleProviderPluginEntry(...)`ヘルパーを使用してください：

    ```typescript
    import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

    export default defineSingleProviderPluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      provider: {
        label: "Acme AI",
        docsPath: "/providers/acme-ai",
        auth: [
          {
            methodId: "api-key",
            label: "Acme AI API key",
            hint: "API key from your Acme AI dashboard",
            optionKey: "acmeAiApiKey",
            flagName: "--acme-ai-api-key",
            envVar: "ACME_AI_API_KEY",
            promptMessage: "Enter your Acme AI API key",
            defaultModel: "acme-ai/acme-large",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.acme-ai.com/v1",
            models: [{ id: "acme-large", name: "Acme Large" }],
          }),
        },
      },
    });
    ```

    認証フローでオンボーディング中に`models.providers.*`、エイリアス、エージェントのデフォルトモデルもパッチする必要がある場合は、`openclaw/plugin-sdk/provider-onboard`のプリセットヘルパーを使用してください。最もシンプルなヘルパーは`createDefaultModelPresetAppliers(...)`、`createDefaultModelsPresetAppliers(...)`、`createModelCatalogPresetAppliers(...)`です。

  </Step>

  <Step title="動的モデル解決の追加">
    プロバイダーが任意のモデルIDを受け付ける場合（プロキシやルーターなど）、`resolveDynamicModel`を追加します：

    ```typescript
    api.registerProvider({
      // ... 上記のid、label、auth、catalog

      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "acme-ai",
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
    });
    ```

    解決にネットワーク呼び出しが必要な場合は、非同期のウォームアップに`prepareDynamicModel`を使用してください。完了後に`resolveDynamicModel`が再度実行されます。

  </Step>

  <Step title="ランタイムフックの追加（必要に応じて）">
    ほとんどのプロバイダーは`catalog` + `resolveDynamicModel`だけで十分です。プロバイダーの要件に応じてフックを段階的に追加してください。

    <Tabs>
      <Tab title="トークン交換">
        各推論呼び出しの前にトークン交換が必要なプロバイダーの場合：

        ```typescript
        prepareRuntimeAuth: async (ctx) => {
          const exchanged = await exchangeToken(ctx.apiKey);
          return {
            apiKey: exchanged.token,
            baseUrl: exchanged.baseUrl,
            expiresAt: exchanged.expiresAt,
          };
        },
        ```
      </Tab>
      <Tab title="カスタムヘッダー">
        カスタムリクエストヘッダーやボディの変更が必要なプロバイダーの場合：

        ```typescript
        // wrapStreamFnはctx.streamFnから派生したStreamFnを返します
        wrapStreamFn: (ctx) => {
          if (!ctx.streamFn) return undefined;
          const inner = ctx.streamFn;
          return async (params) => {
            params.headers = {
              ...params.headers,
              "X-Acme-Version": "2",
            };
            return inner(params);
          };
        },
        ```
      </Tab>
      <Tab title="使用量と課金">
        使用量/課金データを公開するプロバイダーの場合：

        ```typescript
        resolveUsageAuth: async (ctx) => {
          const auth = await ctx.resolveOAuthToken();
          return auth ? { token: auth.token } : null;
        },
        fetchUsageSnapshot: async (ctx) => {
          return await fetchAcmeUsage(ctx.token, ctx.timeoutMs);
        },
        ```
      </Tab>
    </Tabs>

    <Accordion title="利用可能なすべてのプロバイダーフック">
      OpenClawはフックを以下の順序で呼び出します。ほとんどのプロバイダーは2〜3個のみ使用します：

      | # | フック | 使用するタイミング |
      | --- | --- | --- |
      | 1 | `catalog` | モデルカタログまたはベースURLのデフォルト |
      | 2 | `resolveDynamicModel` | 任意のアップストリームモデルIDを受け付ける場合 |
      | 3 | `prepareDynamicModel` | 解決前の非同期メタデータ取得 |
      | 4 | `normalizeResolvedModel` | ランナー前のトランスポート書き換え |
      | 5 | `capabilities` | トランスクリプト/ツーリングメタデータ（データのみ、呼び出し不可） |
      | 6 | `prepareExtraParams` | デフォルトのリクエストパラメータ |
      | 7 | `wrapStreamFn` | カスタムヘッダー/ボディラッパー |
      | 8 | `formatApiKey` | カスタムランタイムトークン形状 |
      | 9 | `refreshOAuth` | カスタムOAuthリフレッシュ |
      | 10 | `buildAuthDoctorHint` | 認証修復ガイダンス |
      | 11 | `isCacheTtlEligible` | プロンプトキャッシュTTLゲーティング |
      | 12 | `buildMissingAuthMessage` | カスタムの認証欠落ヒント |
      | 13 | `suppressBuiltInModel` | 古いアップストリーム行の非表示 |
      | 14 | `augmentModelCatalog` | 合成的な前方互換行 |
      | 15 | `isBinaryThinking` | バイナリ思考のオン/オフ |
      | 16 | `supportsXHighThinking` | `xhigh`推論サポート |
      | 17 | `resolveDefaultThinkingLevel` | デフォルトの`/think`ポリシー |
      | 18 | `isModernModelRef` | ライブ/スモークモデルマッチング |
      | 19 | `prepareRuntimeAuth` | 推論前のトークン交換 |
      | 20 | `resolveUsageAuth` | カスタム使用量認証情報の解析 |
      | 21 | `fetchUsageSnapshot` | カスタム使用量エンドポイント |
      | 22 | `onModelSelected` | 選択後のコールバック（例：テレメトリ） |
      | 23 | `buildReplayPolicy` | カスタムトランスクリプトポリシー（例：思考ブロックの除去） |
      | 24 | `sanitizeReplayHistory` | 汎用クリーンアップ後のプロバイダー固有リプレイ書き換え |
      | 25 | `validateReplayTurns` | 組み込みランナー前の厳密なリプレイターン検証 |

      詳細な説明と実例については、[内部構造: プロバイダーランタイムフック](/plugins/architecture#provider-runtime-hooks)を参照してください。
    </Accordion>

  </Step>

  <Step title="追加機能の追加（オプション）">
    <a id="step-5-add-extra-capabilities"></a>
    プロバイダープラグインは、テキスト推論に加えて音声合成、メディア理解、画像生成、Web検索を登録できます：

    ```typescript
    register(api) {
      api.registerProvider({ id: "acme-ai", /* ... */ });

      api.registerSpeechProvider({
        id: "acme-ai",
        label: "Acme Speech",
        isConfigured: ({ config }) => Boolean(config.messages?.tts),
        synthesize: async (req) => ({
          audioBuffer: Buffer.from(/* PCM data */),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        }),
      });

      api.registerMediaUnderstandingProvider({
        id: "acme-ai",
        capabilities: ["image", "audio"],
        describeImage: async (req) => ({ text: "A photo of..." }),
        transcribeAudio: async (req) => ({ text: "Transcript..." }),
      });

      api.registerImageGenerationProvider({
        id: "acme-ai",
        label: "Acme Images",
        generate: async (req) => ({ /* image result */ }),
      });
    }
    ```

    OpenClawはこれを**ハイブリッド機能**プラグインとして分類します。これは企業向けプラグイン（1ベンダーにつき1プラグイン）の推奨パターンです。[内部構造: 機能所有モデル](/plugins/architecture#capability-ownership-model)を参照してください。

  </Step>

  <Step title="テスト">
    <a id="step-6-test"></a>
    ```typescript src/provider.test.ts
    import { describe, it, expect } from "vitest";
    // index.tsまたは専用ファイルからプロバイダー設定オブジェクトをエクスポートしてください
    import { acmeProvider } from "./provider.js";

    describe("acme-ai provider", () => {
      it("resolves dynamic models", () => {
        const model = acmeProvider.resolveDynamicModel!({
          modelId: "acme-beta-v3",
        } as any);
        expect(model.id).toBe("acme-beta-v3");
        expect(model.provider).toBe("acme-ai");
      });

      it("returns catalog when key is available", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: "test-key" }),
        } as any);
        expect(result?.provider?.models).toHaveLength(2);
      });

      it("returns null catalog when no key", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        } as any);
        expect(result).toBeNull();
      });
    });
    ```

  </Step>
</Steps>

## ClawHubへの公開

プロバイダープラグインは、他の外部コードプラグインと同じ方法で公開します：

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

ここではレガシーのSkill専用公開エイリアスは使用しないでください。プラグインパッケージは`clawhub package publish`を使用してください。

## ファイル構造

```
<bundled-plugin-root>/acme-ai/
├── package.json              # openclaw.providersメタデータ
├── openclaw.plugin.json      # providerAuthEnvVarsを含むマニフェスト
├── index.ts                  # definePluginEntry + registerProvider
└── src/
    ├── provider.test.ts      # テスト
    └── usage.ts              # 使用量エンドポイント（オプション）
```

## カタログ順序リファレンス

`catalog.order`は、組み込みプロバイダーに対するカタログのマージタイミングを制御します：

| 順序 | タイミング | ユースケース |
| --------- | ------------- | ----------------------------------------------- |
| `simple`  | 最初のパス | シンプルなAPIキープロバイダー |
| `profile` | simpleの後 | 認証プロファイルに基づくプロバイダー |
| `paired`  | profileの後 | 複数の関連エントリを合成する場合 |
| `late`    | 最後のパス | 既存プロバイダーの上書き（衝突時に優先） |

## 次のステップ

- [チャネルプラグイン](/plugins/sdk-channel-plugins) — プラグインがチャネルも提供する場合
- [SDKランタイム](/plugins/sdk-runtime) — `api.runtime`ヘルパー（TTS、検索、サブエージェント）
- [SDK 概要](/plugins/sdk-overview) — サブパスインポートの完全なリファレンス
- [プラグイン内部構造](/plugins/architecture#provider-runtime-hooks) — フックの詳細とバンドル例
