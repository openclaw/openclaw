---
summary: "設定の概要: よく使うタスク、クイックセットアップ、フルリファレンスへのリンク"
read_when:
  - OpenClaw を初めてセットアップするとき
  - よく使う設定パターンを探しているとき
  - 特定の設定セクションに移動するとき
title: "設定"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: d18f1673ecb2f0fe4c30cfc05a4fb3c215da29333ad815f83bd8cafd5f3f1c44
    source_path: gateway/configuration.md
    workflow: 15
---

# 設定

OpenClaw は `~/.openclaw/openclaw.json` にある任意の <Tooltip tip="JSON5 はコメントと末尾カンマをサポートしています">**JSON5**</Tooltip> 設定ファイルを読み込みます。

ファイルが存在しない場合、OpenClaw は安全なデフォルト値を使用します。設定を追加する主な理由:

- チャンネルを接続して、ボットにメッセージを送信できるユーザーを制御する
- モデル、ツール、サンドボックス、自動化（cron、フック）を設定する
- セッション、メディア、ネットワーク、UI を調整する

利用可能なすべてのフィールドについては [フルリファレンス](/gateway/configuration-reference) を参照してください。

<Tip>
**設定が初めてですか?** インタラクティブなセットアップには `openclaw onboard` から始めるか、コピー&ペースト可能な完全な設定例については [設定例](/gateway/configuration-examples) ガイドをご覧ください。
</Tip>

## 最小設定

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## 設定の編集

<Tabs>
  <Tab title="インタラクティブウィザード">
    ```bash
    openclaw onboard       # フルオンボーディングフロー
    openclaw configure     # 設定ウィザード
    ```
  </Tab>
  <Tab title="CLI（ワンライナー）">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset plugins.entries.brave.config.webSearch.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    [http://127.0.0.1:18789](http://127.0.0.1:18789) を開いて **Config** タブを使用します。
    Control UI は設定スキーマからフォームを表示し、**Raw JSON** エディタをエスケープハッチとして提供します。
  </Tab>
  <Tab title="直接編集">
    `~/.openclaw/openclaw.json` を直接編集します。Gateway ゲートウェイはファイルを監視して自動的に変更を適用します（[ホットリロード](#config-hot-reload)を参照）。
  </Tab>
</Tabs>

## 厳格なバリデーション

<Warning>
OpenClaw はスキーマに完全に一致する設定のみを受け付けます。不明なキー、不正な型、無効な値があると Gateway ゲートウェイは**起動を拒否**します。唯一のルートレベルの例外は `$schema`（文字列）で、エディタが JSON スキーマメタデータを添付できます。
</Warning>

バリデーションに失敗した場合:

- Gateway ゲートウェイは起動しない
- 診断コマンドのみ動作する（`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`）
- 正確な問題を確認するには `openclaw doctor` を実行する
- 修復を適用するには `openclaw doctor --fix`（または `--yes`）を実行する

## よく使うタスク

<AccordionGroup>
  <Accordion title="チャンネルをセットアップする（WhatsApp、Telegram、Discord など）">
    各チャンネルには `channels.<provider>` の下に独自の設定セクションがあります。セットアップ手順については専用のチャンネルページを参照してください:

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/channels/telegram) — `channels.telegram`
    - [Discord](/channels/discord) — `channels.discord`
    - [Slack](/channels/slack) — `channels.slack`
    - [Signal](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [Google Chat](/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/channels/mattermost) — `channels.mattermost`
    - [Microsoft Teams](/channels/msteams) — `channels.msteams`

    すべてのチャンネルは同じ DM ポリシーパターンを共有しています:

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // allowlist/open の場合のみ
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="モデルを選択・設定する">
    プライマリモデルとオプションのフォールバックを設定します:

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` はモデルカタログを定義し、`/model` のアローリストとして機能します。
    - モデル参照は `provider/model` 形式を使用します（例: `anthropic/claude-opus-4-6`）。
    - `agents.defaults.imageMaxDimensionPx` はトランスクリプト/ツールの画像のダウンスケーリングを制御します（デフォルト `1200`）。スクリーンショットが多い実行では値を低くするとビジョントークンの使用量が通常減少します。
    - チャットでのモデル切り替えについては [Models CLI](/concepts/models) を、認証ローテーションとフォールバック動作については [モデルフェイルオーバー](/concepts/model-failover) を参照してください。
    - カスタム/セルフホステッドプロバイダーについては、リファレンスの [カスタムプロバイダー](/gateway/configuration-reference#custom-providers-and-base-urls) を参照してください。

  </Accordion>

  <Accordion title="ボットにメッセージを送信できるユーザーを制御する">
    DM アクセスはチャンネルごとに `dmPolicy` で制御されます:

    - `"pairing"`（デフォルト）: 不明な送信者は承認のためにワンタイムペアリングコードを受け取る
    - `"allowlist"`: `allowFrom`（またはペアリングされた許可ストア）の送信者のみ
    - `"open"`: すべての着信 DM を許可（`allowFrom: ["*"]` が必要）
    - `"disabled"`: すべての DM を無視する

    グループには `groupPolicy` + `groupAllowFrom` またはチャンネル固有のアローリストを使用します。

    チャンネルごとの詳細については [フルリファレンス](/gateway/configuration-reference#dm-and-group-access) を参照してください。

  </Accordion>

  <Accordion title="グループチャットメンションゲーティングをセットアップする">
    グループメッセージはデフォルトで**メンションを必要**とします。エージェントごとにパターンを設定します:

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **メタデータメンション**: ネイティブの @-メンション（WhatsApp タップしてメンション、Telegram @bot など）
    - **テキストパターン**: `mentionPatterns` の安全な正規表現パターン
    - チャンネルごとのオーバーライドとセルフチャットモードについては [フルリファレンス](/gateway/configuration-reference#group-chat-mention-gating) を参照してください。

  </Accordion>

  <Accordion title="Gateway ゲートウェイチャンネルヘルスモニタリングを調整する">
    Gateway ゲートウェイが古く見えるチャンネルを再起動する積極性を制御します:

    ```json5
    {
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 30,
        channelMaxRestartsPerHour: 10,
      },
      channels: {
        telegram: {
          healthMonitor: { enabled: false },
          accounts: {
            alerts: {
              healthMonitor: { enabled: true },
            },
          },
        },
      },
    }
    ```

    - `gateway.channelHealthCheckMinutes: 0` を設定すると、グローバルにヘルスモニター再起動を無効化します。
    - `channelStaleEventThresholdMinutes` はチェック間隔以上である必要があります。
    - `channels.<provider>.healthMonitor.enabled` または `channels.<provider>.accounts.<id>.healthMonitor.enabled` を使用して、グローバルモニターを無効にせずに 1 つのチャンネルまたはアカウントの自動再起動を無効にします。
    - 運用デバッグについては [ヘルスチェック](/gateway/health) を、すべてのフィールドについては [フルリファレンス](/gateway/configuration-reference#gateway) を参照してください。

  </Accordion>

  <Accordion title="セッションとリセットを設定する">
    セッションは会話の継続性と分離を制御します:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // マルチユーザーに推奨
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main`（共有） | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`: スレッドバインドセッションルーティングのグローバルデフォルト（Discord は `/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age` をサポート）。
    - スコープ、アイデンティティリンク、送信ポリシーについては [セッション管理](/concepts/session) を参照してください。
    - すべてのフィールドについては [フルリファレンス](/gateway/configuration-reference#session) を参照してください。

  </Accordion>

  <Accordion title="サンドボックスを有効にする">
    エージェントセッションを分離された Docker コンテナで実行します:

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    まずイメージをビルドします: `scripts/sandbox-setup.sh`

    フルガイドについては [サンドボックス](/gateway/sandboxing) を、すべてのオプションについては [フルリファレンス](/gateway/configuration-reference#agentsdefaultssandbox) を参照してください。

  </Accordion>

  <Accordion title="公式 iOS ビルド向けリレーバックアップ Push を有効にする">
    リレーバックアップ Push は `openclaw.json` で設定します。

    Gateway ゲートウェイ設定でこれを設定します:

    ```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // オプション。デフォルト: 10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

    CLI 相当:

    ```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

    この設定の効果:

    - Gateway ゲートウェイが外部リレーを通じて `push.test`、ウェイクナッジ、再接続ウェイクを送信できるようにします。
    - ペアリングされた iOS アプリから転送された登録スコープの送信グラントを使用します。Gateway ゲートウェイはデプロイ全体のリレートークンを必要としません。
    - 各リレーバックアップ登録を iOS アプリがペアリングした Gateway ゲートウェイのアイデンティティにバインドするため、別の Gateway ゲートウェイが保存された登録を再利用できません。
    - ローカル/手動の iOS ビルドは直接 APNs を使用します。リレーバックアップ送信は、リレーを通じて登録された公式の配布ビルドにのみ適用されます。
    - 登録と送信トラフィックが同じリレーデプロイメントに届くように、公式/TestFlight iOS ビルドに組み込まれたリレーベース URL と一致している必要があります。

    エンドツーエンドフロー:

    1. 同じリレーベース URL でコンパイルされた公式/TestFlight iOS ビルドをインストールします。
    2. Gateway ゲートウェイで `gateway.push.apns.relay.baseUrl` を設定します。
    3. iOS アプリを Gateway ゲートウェイにペアリングし、ノードとオペレーターの両方のセッションを接続します。
    4. iOS アプリが Gateway ゲートウェイのアイデンティティを取得し、App Attest とアプリのレシートを使用してリレーに登録し、ペアリングされた Gateway ゲートウェイにリレーバックアップの `push.apns.register` ペイロードを公開します。
    5. Gateway ゲートウェイはリレーハンドルと送信グラントを保存し、`push.test`、ウェイクナッジ、再接続ウェイクに使用します。

    運用上の注意:

    - iOS アプリを別の Gateway ゲートウェイに切り替える場合は、アプリを再接続して、その Gateway ゲートウェイにバインドされた新しいリレー登録を公開できるようにします。
    - 別のリレーデプロイメントを指す新しい iOS ビルドを配布する場合、アプリは古いリレーオリジンを再利用せずにキャッシュされたリレー登録を更新します。

    互換性に関する注意:

    - `OPENCLAW_APNS_RELAY_BASE_URL` と `OPENCLAW_APNS_RELAY_TIMEOUT_MS` は一時的な環境変数オーバーライドとして引き続き機能します。
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` はループバックのみの開発エスケープハッチとして残っています。HTTP リレー URL を設定に保存しないでください。

    エンドツーエンドフローについては [iOS アプリ](/platforms/ios#relay-backed-push-for-official-builds) を、リレーセキュリティモデルについては [認証とトラストフロー](/platforms/ios#authentication-and-trust-flow) を参照してください。

  </Accordion>

  <Accordion title="ハートビート（定期的なチェックイン）をセットアップする">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every`: 期間文字列（`30m`、`2h`）。無効にするには `0m` を設定。
    - `target`: `last` | `none` | `<channel-id>`（例: `discord`、`matrix`、`telegram`、`whatsapp`）
    - `directPolicy`: DM スタイルのハートビートターゲットに対して `allow`（デフォルト）または `block`
    - フルガイドについては [ハートビート](/gateway/heartbeat) を参照してください。

  </Accordion>

  <Accordion title="cron ジョブを設定する">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
        runLog: {
          maxBytes: "2mb",
          keepLines: 2000,
        },
      },
    }
    ```

    - `sessionRetention`: `sessions.json` から完了した分離実行セッションを削除します（デフォルト `24h`。無効にするには `false` を設定）。
    - `runLog`: サイズと保持行数によって `cron/runs/<jobId>.jsonl` を削除します。
    - 機能の概要と CLI の例については [cron ジョブ](/automation/cron-jobs) を参照してください。

  </Accordion>

  <Accordion title="webhook（フック）をセットアップする">
    Gateway ゲートウェイで HTTP webhook エンドポイントを有効にします:

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    セキュリティに関する注意:
    - フック/webhook のペイロードコンテンツはすべて信頼できない入力として扱います。
    - 安全でないコンテンツのバイパスフラグを無効のままにします（`hooks.gmail.allowUnsafeExternalContent`、`hooks.mappings[].allowUnsafeExternalContent`）。範囲を絞ったデバッグをしている場合は除きます。
    - フック駆動のエージェントには、強力な最新モデル層と厳格なツールポリシーを優先します（例: 可能な場合はメッセージングのみとサンドボックスの組み合わせ）。

    すべてのマッピングオプションと Gmail 連携については [フルリファレンス](/gateway/configuration-reference#hooks) を参照してください。

  </Accordion>

  <Accordion title="マルチエージェントルーティングを設定する">
    個別のワークスペースとセッションで複数の分離エージェントを実行します:

    ```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    バインディングルールとエージェントごとのアクセスプロファイルについては [マルチエージェント](/concepts/multi-agent) と [フルリファレンス](/gateway/configuration-reference#multi-agent-routing) を参照してください。

  </Accordion>

  <Accordion title="設定を複数のファイルに分割する（$include）">
    `$include` を使用して大きな設定を整理します:

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **単一ファイル**: 含まれるオブジェクトを置き換えます
    - **ファイルの配列**: 順番にディープマージされます（後のものが優先）
    - **兄弟キー**: インクルードの後にマージされます（インクルードされた値をオーバーライド）
    - **ネストされたインクルード**: 最大 10 レベル深くサポート
    - **相対パス**: インクルードしているファイルからの相対パスで解決
    - **エラーハンドリング**: 欠落したファイル、パースエラー、循環インクルードに対して明確なエラーを表示

  </Accordion>
</AccordionGroup>

## 設定のホットリロード

Gateway ゲートウェイは `~/.openclaw/openclaw.json` を監視して自動的に変更を適用します。ほとんどの設定では手動での再起動は不要です。

### リロードモード

| モード                   | 動作                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **`hybrid`**（デフォルト） | 安全な変更を即座にホット適用します。重要な変更には自動的に再起動します。           |
| **`hot`**              | 安全な変更のみホット適用します。再起動が必要な場合は警告をログに記録します。自分で処理してください。 |
| **`restart`**          | 安全かどうかにかかわらず、設定変更があると Gateway ゲートウェイを再起動します。                                 |
| **`off`**              | ファイル監視を無効にします。変更は次の手動再起動で有効になります。                 |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### ホット適用されるものと再起動が必要なもの

ほとんどのフィールドはダウンタイムなしでホット適用されます。`hybrid` モードでは、再起動が必要な変更は自動的に処理されます。

| カテゴリ            | フィールド                                                               | 再起動必要? |
| ------------------- | -------------------------------------------------------------------- | --------------- |
| チャンネル            | `channels.*`、`web`（WhatsApp） — すべての組み込みおよびエクステンションチャンネル | いいえ              |
| エージェントとモデル      | `agent`、`agents`、`models`、`routing`                               | いいえ              |
| 自動化          | `hooks`、`cron`、`agent.heartbeat`                                   | いいえ              |
| セッションとメッセージ | `session`、`messages`                                                | いいえ              |
| ツールとメディア       | `tools`、`browser`、`skills`、`audio`、`talk`                        | いいえ              |
| UI その他           | `ui`、`logging`、`identity`、`bindings`                              | いいえ              |
| Gateway ゲートウェイサーバー      | `gateway.*`（ポート、バインド、認証、Tailscale、TLS、HTTP）                 | **はい**         |
| インフラ      | `discovery`、`canvasHost`、`plugins`                                 | **はい**         |

<Note>
`gateway.reload` と `gateway.remote` は例外です。これらを変更しても再起動は**トリガーされません**。
</Note>

## 設定 RPC（プログラムによる更新）

<Note>
コントロールプレーンの書き込み RPC（`config.apply`、`config.patch`、`update.run`）は `deviceId+clientIp` ごとに **60 秒あたり 3 リクエスト**にレート制限されています。制限された場合、RPC は `retryAfterMs` を含む `UNAVAILABLE` を返します。
</Note>

<AccordionGroup>
  <Accordion title="config.apply（フル置き換え）">
    設定全体をバリデーションして書き込み、一度に Gateway ゲートウェイを再起動します。

    <Warning>
    `config.apply` は**設定全体**を置き換えます。部分的な更新には `config.patch` を使用するか、単一キーには `openclaw config set` を使用してください。
    </Warning>

    パラメータ:

    - `raw`（文字列） — 設定全体の JSON5 ペイロード
    - `baseHash`（オプション） — `config.get` からの設定ハッシュ（設定が存在する場合に必要）
    - `sessionKey`（オプション） — 再起動後のウェイクアップ Ping のセッションキー
    - `note`（オプション） — 再起動センチネルの注記
    - `restartDelayMs`（オプション） — 再起動前の遅延（デフォルト 2000）

    1 つが既にペンディング/実行中の間は再起動リクエストが集約され、再起動サイクル間には 30 秒のクールダウンが適用されます。

    ```bash
    openclaw gateway call config.get --params '{}'  # payload.hash を取得
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:direct:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch（部分的な更新）">
    既存の設定に部分的な更新をマージします（JSON マージパッチセマンティクス）:

    - オブジェクトは再帰的にマージされる
    - `null` はキーを削除する
    - 配列は置き換えられる

    パラメータ:

    - `raw`（文字列） — 変更するキーのみの JSON5
    - `baseHash`（必須） — `config.get` からの設定ハッシュ
    - `sessionKey`、`note`、`restartDelayMs` — `config.apply` と同じ

    再起動動作は `config.apply` と同じです: ペンディングの再起動が集約され、再起動サイクル間に 30 秒のクールダウンがあります。

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 環境変数

OpenClaw は親プロセスからの環境変数に加えて以下からも読み込みます:

- 現在の作業ディレクトリの `.env`（存在する場合）
- `~/.openclaw/.env`（グローバルフォールバック）

どちらのファイルも既存の環境変数をオーバーライドしません。設定でインラインの環境変数を設定することもできます:

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="シェル環境のインポート（オプション）">
  有効にすると、期待されるキーが設定されていない場合、OpenClaw はログインシェルを実行して欠落しているキーのみをインポートします:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

環境変数相当: `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="設定値での環境変数置換">
  任意の設定文字列値で `${VAR_NAME}` を使用して環境変数を参照します:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

ルール:

- 大文字名のみマッチします: `[A-Z_][A-Z0-9_]*`
- 欠落/空の変数はロード時にエラーをスローします
- リテラル出力には `$${VAR}` でエスケープします
- `$include` ファイル内でも機能します
- インライン置換: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="シークレット参照（env、file、exec）">
  SecretRef オブジェクトをサポートするフィールドでは次を使用できます:

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "image-lab": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/image-lab/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccountRef: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

SecretRef の詳細（`env`/`file`/`exec` 用の `secrets.providers` を含む）は [シークレット管理](/gateway/secrets) にあります。
サポートされている認証情報パスは [SecretRef 認証情報サーフェス](/reference/secretref-credential-surface) に一覧があります。
</Accordion>

完全な優先順位とソースについては [環境](/help/environment) を参照してください。

## フルリファレンス

フィールドごとの完全なリファレンスについては **[設定リファレンス](/gateway/configuration-reference)** を参照してください。

---

_関連: [設定例](/gateway/configuration-examples) · [設定リファレンス](/gateway/configuration-reference) · [Doctor](/gateway/doctor)_
