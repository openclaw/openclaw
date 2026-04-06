---
read_when:
    - 新しいメッセージングチャネルプラグインを構築する場合
    - OpenClawをメッセージングプラットフォームに接続したい場合
    - ChannelPluginアダプターの仕組みを理解する必要がある場合
sidebarTitle: Channel Plugins
summary: OpenClawのメッセージングチャネルプラグインを構築するためのステップバイステップガイド
title: チャネルプラグインの構築
x-i18n:
    generated_at: "2026-04-02T07:50:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 67ae2e546bb8c2032143068a079c65c0bbdeda2a4c9539bad024bd21bf1c9d64
    source_path: plugins/sdk-channel-plugins.md
    workflow: 15
---

# チャネルプラグインの構築

このガイドでは、OpenClawをメッセージングプラットフォームに接続するチャネルプラグインの構築手順を説明します。最終的に、ダイレクトメッセージのセキュリティ、ペアリング、返信スレッド、送信メッセージングを備えた動作するチャネルが完成します。

<Info>
  OpenClawプラグインを初めて構築する場合は、まず[はじめに](/plugins/building-plugins)を読んで、基本的なパッケージ構成とマニフェストのセットアップを確認してください。
</Info>

## チャネルプラグインの仕組み

チャネルプラグインは独自の送信/編集/リアクションツールを必要としません。OpenClawはコアに共有の`message`ツールを1つ保持しています。プラグインが担当するのは以下の部分です：

- **設定** — アカウント解決とセットアップウィザード
- **セキュリティ** — ダイレクトメッセージポリシーと許可リスト
- **ペアリング** — ダイレクトメッセージの承認フロー
- **セッション文法** — プロバイダー固有の会話IDがベースチャット、スレッドID、親フォールバックにどのようにマッピングされるか
- **送信** — テキスト、メディア、投票のプラットフォームへの送信
- **スレッディング** — 返信のスレッド化方法

コアは共有メッセージツール、プロンプト配線、外部セッションキーの形状、汎用的な`:thread:`の管理、およびディスパッチを担当します。

プラットフォームが会話IDに追加のスコープを格納する場合は、`messaging.resolveSessionConversation(...)`を使ってプラグイン内でその解析を行います。これは`rawId`をベース会話ID、オプションのスレッドID、明示的な`baseConversationId`、および`parentConversationCandidates`にマッピングするための正規フックです。
`parentConversationCandidates`を返す場合は、最も狭い親から最も広い/ベースの会話の順に並べてください。

チャネルレジストリの起動前に同じ解析が必要なバンドルプラグインは、トップレベルの`session-key-api.ts`ファイルに対応する`resolveSessionConversation(...)`エクスポートを公開することもできます。コアはランタイムプラグインレジストリがまだ利用できない場合にのみ、このブートストラップセーフな仕組みを使用します。

`messaging.resolveParentConversationCandidates(...)`は、プラグインが汎用/生IDの上に親フォールバックのみを必要とする場合のレガシー互換フォールバックとして引き続き利用可能です。両方のフックが存在する場合、コアはまず`resolveSessionConversation(...).parentConversationCandidates`を使用し、正規フックがそれらを省略した場合にのみ`resolveParentConversationCandidates(...)`にフォールバックします。

## 承認とチャネル機能

ほとんどのチャネルプラグインは承認固有のコードを必要としません。

- コアは同一チャットの`/approve`、共有承認ボタンペイロード、および汎用フォールバック配信を担当します。
- チャネルが承認固有の動作を必要とする場合は、チャネルプラグインに1つの`approvalCapability`オブジェクトを設定することを推奨します。
- `approvalCapability.authorizeActorAction`と`approvalCapability.getActionAvailabilityState`が承認認可の正規シームです。
- 重複するローカル承認プロンプトの非表示や配信前のタイピングインジケーター送信など、チャネル固有のペイロードライフサイクル動作には`outbound.shouldSuppressLocalPayloadPrompt`または`outbound.beforeDeliverPayload`を使用してください。
- ネイティブ承認ルーティングやフォールバック抑制にのみ`approvalCapability.delivery`を使用してください。
- チャネルが共有レンダラーの代わりにカスタム承認ペイロードを本当に必要とする場合にのみ`approvalCapability.render`を使用してください。
- チャネルが既存の設定から安定したオーナー的なダイレクトメッセージIDを推測できる場合は、`openclaw/plugin-sdk/approval-runtime`の`createResolvedApproverActionAuthAdapter`を使用して、承認固有のコアロジックを追加せずに同一チャットの`/approve`を制限してください。
- チャネルがネイティブ承認配信を必要とする場合は、チャネルコードをターゲットの正規化とトランスポートフックに集中させてください。`openclaw/plugin-sdk/approval-runtime`の`createChannelExecApprovalProfile`、`createChannelNativeOriginTargetResolver`、`createChannelApproverDmTargetResolver`、`createApproverRestrictedNativeApprovalCapability`、および`createChannelNativeApprovalRuntime`を使用して、コアがリクエストフィルタリング、ルーティング、重複排除、期限切れ、Gateway ゲートウェイサブスクリプションを担当するようにしてください。
- ネイティブ承認チャネルは`accountId`と`approvalKind`の両方をこれらのヘルパー経由でルーティングする必要があります。`accountId`はマルチアカウント承認ポリシーを正しいボットアカウントにスコープし、`approvalKind`はコアにハードコードされた分岐なしでexecとプラグインの承認動作をチャネルに提供します。
- `createApproverRestrictedNativeApprovalAdapter`は互換ラッパーとして引き続き存在しますが、新しいコードではcapabilityビルダーを使用して、プラグインに`approvalCapability`を公開することを推奨します。

認証のみのチャネルは通常、デフォルトパスで停止できます：コアが承認を処理し、プラグインは送信/認証機能のみを公開します。Matrix、Slack、Telegram、カスタムチャットトランスポートなどのネイティブ承認チャネルは、独自の承認ライフサイクルを実装する代わりに共有ネイティブヘルパーを使用してください。

## ウォークスルー

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="パッケージとマニフェスト">
    標準的なプラグインファイルを作成します。`package.json`の`channel`フィールドが、これをチャネルプラグインにします：

    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-chat",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "acme-chat",
          "label": "Acme Chat",
          "blurb": "Connect OpenClaw to Acme Chat."
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-chat",
      "kind": "channel",
      "channels": ["acme-chat"],
      "name": "Acme Chat",
      "description": "Acme Chat channel plugin",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "acme-chat": {
            "type": "object",
            "properties": {
              "token": { "type": "string" },
              "allowFrom": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          }
        }
      }
    }
    ```
    </CodeGroup>

  </Step>

  <Step title="チャネルプラグインオブジェクトの構築">
    `ChannelPlugin`インターフェースには多くのオプションアダプターがあります。最小限の`id`と`setup`から始めて、必要に応じてアダプターを追加してください。

    `src/channel.ts`を作成します：

    ```typescript src/channel.ts
    import {
      createChatChannelPlugin,
      createChannelPluginBase,
    } from "openclaw/plugin-sdk/core";
    import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
    import { acmeChatApi } from "./client.js"; // your platform API client

    type ResolvedAccount = {
      accountId: string | null;
      token: string;
      allowFrom: string[];
      dmPolicy: string | undefined;
    };

    function resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount {
      const section = (cfg.channels as Record<string, any>)?.["acme-chat"];
      const token = section?.token;
      if (!token) throw new Error("acme-chat: token is required");
      return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmSecurity,
      };
    }

    export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
      base: createChannelPluginBase({
        id: "acme-chat",
        setup: {
          resolveAccount,
          inspectAccount(cfg, accountId) {
            const section =
              (cfg.channels as Record<string, any>)?.["acme-chat"];
            return {
              enabled: Boolean(section?.token),
              configured: Boolean(section?.token),
              tokenStatus: section?.token ? "available" : "missing",
            };
          },
        },
      }),

      // DM security: who can message the bot
      security: {
        dm: {
          channelKey: "acme-chat",
          resolvePolicy: (account) => account.dmPolicy,
          resolveAllowFrom: (account) => account.allowFrom,
          defaultPolicy: "allowlist",
        },
      },

      // Pairing: approval flow for new DM contacts
      pairing: {
        text: {
          idLabel: "Acme Chat username",
          message: "Send this code to verify your identity:",
          notify: async ({ target, code }) => {
            await acmeChatApi.sendDm(target, `Pairing code: ${code}`);
          },
        },
      },

      // Threading: how replies are delivered
      threading: { topLevelReplyToMode: "reply" },

      // Outbound: send messages to the platform
      outbound: {
        attachedResults: {
          sendText: async (params) => {
            const result = await acmeChatApi.sendMessage(
              params.to,
              params.text,
            );
            return { messageId: result.id };
          },
        },
        base: {
          sendMedia: async (params) => {
            await acmeChatApi.sendFile(params.to, params.filePath);
          },
        },
      },
    });
    ```

    <Accordion title="createChatChannelPluginが行うこと">
      低レベルのアダプターインターフェースを手動で実装する代わりに、宣言的なオプションを渡すとビルダーがそれらを合成します：

      | オプション | 配線される内容 |
      | --- | --- |
      | `security.dm` | 設定フィールドからのスコープ付きダイレクトメッセージセキュリティリゾルバー |
      | `pairing.text` | コード交換によるテキストベースのダイレクトメッセージペアリングフロー |
      | `threading` | 返信モードリゾルバー（固定、アカウントスコープ、またはカスタム） |
      | `outbound.attachedResults` | 結果メタデータ（メッセージID）を返す送信関数 |

      完全な制御が必要な場合は、宣言的オプションの代わりに生のアダプターオブジェクトを渡すこともできます。
    </Accordion>

  </Step>

  <Step title="エントリーポイントの配線">
    `index.ts`を作成します：

    ```typescript index.ts
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineChannelPluginEntry({
      id: "acme-chat",
      name: "Acme Chat",
      description: "Acme Chat channel plugin",
      plugin: acmeChatPlugin,
      registerCliMetadata(api) {
        api.registerCli(
          ({ program }) => {
            program
              .command("acme-chat")
              .description("Acme Chat management");
          },
          {
            descriptors: [
              {
                name: "acme-chat",
                description: "Acme Chat management",
                hasSubcommands: false,
              },
            ],
          },
        );
      },
      registerFull(api) {
        api.registerGatewayMethod(/* ... */);
      },
    });
    ```

    チャネル固有のCLIディスクリプタは`registerCliMetadata(...)`に配置して、完全なチャネルランタイムを有効化せずにOpenClawがルートヘルプに表示できるようにします。通常のフルロードでも同じディスクリプタが実際のコマンド登録に使用されます。`registerFull(...)`はランタイム専用の処理に使用してください。
    `defineChannelPluginEntry`は登録モードの分割を自動的に処理します。すべてのオプションについては[エントリーポイント](/plugins/sdk-entrypoints#definechannelpluginentry)を参照してください。

  </Step>

  <Step title="セットアップエントリーの追加">
    オンボーディング時の軽量ロード用に`setup-entry.ts`を作成します：

    ```typescript setup-entry.ts
    import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineSetupPluginEntry(acmeChatPlugin);
    ```

    OpenClawはチャネルが無効または未設定の場合に、完全なエントリーの代わりにこれをロードします。セットアップフロー中に重いランタイムコードの読み込みを回避します。
    詳細は[セットアップと設定](/plugins/sdk-setup#setup-entry)を参照してください。

  </Step>

  <Step title="受信メッセージの処理">
    プラグインはプラットフォームからメッセージを受信し、OpenClawに転送する必要があります。典型的なパターンは、リクエストを検証してチャネルの受信ハンドラーにディスパッチするWebhookです：

    ```typescript
    registerFull(api) {
      api.registerHttpRoute({
        path: "/acme-chat/webhook",
        auth: "plugin", // plugin-managed auth (verify signatures yourself)
        handler: async (req, res) => {
          const event = parseWebhookPayload(req);

          // Your inbound handler dispatches the message to OpenClaw.
          // The exact wiring depends on your platform SDK —
          // see a real example in the bundled Microsoft Teams or Google Chat plugin package.
          await handleAcmeChatInbound(api, event);

          res.statusCode = 200;
          res.end("ok");
          return true;
        },
      });
    }
    ```

    <Note>
      受信メッセージの処理はチャネル固有です。各チャネルプラグインは独自の受信パイプラインを管理します。実際のパターンについては、バンドルされたチャネルプラグイン（例：Microsoft TeamsやGoogle Chatプラグインパッケージ）を参照してください。
    </Note>

  </Step>

<a id="step-6-test"></a>
<Step title="テスト">
`src/channel.test.ts`にコロケーションテストを記述します：

    ```typescript src/channel.test.ts
    import { describe, it, expect } from "vitest";
    import { acmeChatPlugin } from "./channel.js";

    describe("acme-chat plugin", () => {
      it("resolves account from config", () => {
        const cfg = {
          channels: {
            "acme-chat": { token: "test-token", allowFrom: ["user1"] },
          },
        } as any;
        const account = acmeChatPlugin.setup!.resolveAccount(cfg, undefined);
        expect(account.token).toBe("test-token");
      });

      it("inspects account without materializing secrets", () => {
        const cfg = {
          channels: { "acme-chat": { token: "test-token" } },
        } as any;
        const result = acmeChatPlugin.setup!.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(true);
        expect(result.tokenStatus).toBe("available");
      });

      it("reports missing config", () => {
        const cfg = { channels: {} } as any;
        const result = acmeChatPlugin.setup!.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(false);
      });
    });
    ```

    ```bash
    pnpm test -- <bundled-plugin-root>/acme-chat/
    ```

    共有テストヘルパーについては、[テスト](/plugins/sdk-testing)を参照してください。

  </Step>
</Steps>

## ファイル構成

```
<bundled-plugin-root>/acme-chat/
├── package.json              # openclaw.channel メタデータ
├── openclaw.plugin.json      # 設定スキーマ付きマニフェスト
├── index.ts                  # defineChannelPluginEntry
├── setup-entry.ts            # defineSetupPluginEntry
├── api.ts                    # 公開エクスポート（オプション）
├── runtime-api.ts            # 内部ランタイムエクスポート（オプション）
└── src/
    ├── channel.ts            # createChatChannelPlugin経由のChannelPlugin
    ├── channel.test.ts       # テスト
    ├── client.ts             # プラットフォームAPIクライアント
    └── runtime.ts            # ランタイムストア（必要な場合）
```

## 応用トピック

<CardGroup cols={2}>
  <Card title="スレッディングオプション" icon="git-branch" href="/plugins/sdk-entrypoints#registration-mode">
    固定、アカウントスコープ、またはカスタムの返信モード
  </Card>
  <Card title="メッセージツール統合" icon="puzzle" href="/plugins/architecture#channel-plugins-and-the-shared-message-tool">
    describeMessageToolとアクションディスカバリー
  </Card>
  <Card title="ターゲット解決" icon="crosshair" href="/plugins/architecture#channel-target-resolution">
    inferTargetChatType、looksLikeId、resolveTarget
  </Card>
  <Card title="ランタイムヘルパー" icon="settings" href="/plugins/sdk-runtime">
    TTS、STT、メディア、サブエージェント（api.runtime経由）
  </Card>
</CardGroup>

## 次のステップ

- [プロバイダープラグイン](/plugins/sdk-provider-plugins) — プラグインがモデルも提供する場合
- [SDK 概要](/plugins/sdk-overview) — 完全なサブパスインポートリファレンス
- [プラグインSDK テスト](/plugins/sdk-testing) — テストユーティリティとコントラクトテスト
- [プラグインマニフェスト](/plugins/manifest) — 完全なマニフェストスキーマ
