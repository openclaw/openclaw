---
summary: "設定概要：一般的なタスク、クイックセットアップ、完全リファレンスへのリンク"
read_when:
  - Setting up OpenClaw for the first time
  - Looking for common configuration patterns
  - Navigating to specific config sections
title: "設定"
---

# 設定

OpenClawはオプションの<Tooltip tip="JSON5はコメントと末尾カンマをサポートします">**JSON5**</Tooltip>設定を`~/.openclaw/openclaw.json`から読み取ります。

ファイルがない場合、OpenClawは安全なデフォルトを使用します。設定を追加する一般的な理由：

- チャンネルを接続し、ボットにメッセージを送信できる人を制御する
- モデル、ツール、サンドボックス、自動化（cron、hooks）を設定する
- セッション、メディア、ネットワーク、UIを調整する

使用可能なすべてのフィールドについては、[完全リファレンス](/gateway/configuration-reference)を参照してください。

<Tip>
**設定が初めてですか？** インタラクティブセットアップには`openclaw onboard`を使用するか、完全なコピー＆ペースト設定については[設定例](/gateway/configuration-examples)ガイドを参照してください。
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
    openclaw onboard       # フルセットアップウィザード
    openclaw configure     # 設定ウィザード
    ```
  </Tab>
  <Tab title="CLI（ワンライナー）">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="コントロールUI">
    [http://127.0.0.1:18789](http://127.0.0.1:18789)を開き、**Config**タブを使用します。
    コントロールUIは設定スキーマからフォームをレンダリングし、エスケープハッチとして**Raw JSON**エディタを提供します。
  </Tab>
  <Tab title="直接編集">
    `~/.openclaw/openclaw.json`を直接編集します。Gatewayはファイルを監視し、変更を自動的に適用します（[ホットリロード](#config-hot-reload)を参照）。
  </Tab>
</Tabs>

## 厳密なバリデーション

<Warning>
OpenClawはスキーマに完全に一致する設定のみを受け入れます。不明なキー、不正な型、無効な値により、Gatewayは**起動を拒否**します。唯一のルートレベルの例外は`$schema`（文字列）で、エディタがJSONスキーマメタデータをアタッチできます。
</Warning>

バリデーションが失敗した場合：

- Gatewayは起動しません
- 診断コマンドのみ動作します（`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`）
- `openclaw doctor`を実行して正確な問題を確認してください
- `openclaw doctor --fix`（または`--yes`）を実行して修復を適用してください

## 一般的なタスク

<AccordionGroup>
  <Accordion title="チャンネルのセットアップ（WhatsApp、Telegram、Discordなど）">
    各チャンネルには`channels.<provider>`の下に独自の設定セクションがあります。セットアップ手順については、専用のチャンネルページを参照してください：

    - [WhatsApp](/channels/whatsapp) -- `channels.whatsapp`
    - [Telegram](/channels/telegram) -- `channels.telegram`
    - [Discord](/channels/discord) -- `channels.discord`
    - [Slack](/channels/slack) -- `channels.slack`
    - [Signal](/channels/signal) -- `channels.signal`
    - [iMessage](/channels/imessage) -- `channels.imessage`
    - [Google Chat](/channels/googlechat) -- `channels.googlechat`
    - [Mattermost](/channels/mattermost) -- `channels.mattermost`
    - [MS Teams](/channels/msteams) -- `channels.msteams`

    すべてのチャンネルは同じDMポリシーパターンを共有しています：

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // allowlist/openの場合のみ
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="モデルの選択と設定">
    プライマリモデルとオプションのフォールバックを設定します：

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models`はモデルカタログを定義し、`/model`の許可リストとして機能します。
    - モデル参照は`provider/model`形式を使用します（例：`anthropic/claude-opus-4-6`）。
    - `agents.defaults.imageMaxDimensionPx`はトランスクリプト/ツール画像のダウンスケーリングを制御します（デフォルト`1200`）。値を低くするとスクリーンショットが多い実行でビジョントークンの使用量が削減されます。
    - チャットでのモデル切り替えについては[モデルCLI](/concepts/models)を、認証ローテーションとフォールバック動作については[モデルフェイルオーバー](/concepts/model-failover)を参照してください。
    - カスタム/セルフホストプロバイダーについては、リファレンスの[カスタムプロバイダー](/gateway/configuration-reference#custom-providers-and-base-urls)を参照してください。

  </Accordion>

  <Accordion title="ボットにメッセージを送信できる人の制御">
    DMアクセスはチャンネルごとに`dmPolicy`で制御されます：

    - `"pairing"`（デフォルト）：不明な送信者はワンタイムペアリングコードを受け取り承認を待ちます
    - `"allowlist"`：`allowFrom`（またはペアリング許可ストア）の送信者のみ
    - `"open"`：すべての受信DMを許可（`allowFrom: ["*"]`が必要）
    - `"disabled"`：すべてのDMを無視

    グループの場合は、`groupPolicy` + `groupAllowFrom`またはチャンネル固有の許可リストを使用します。

    チャンネルごとの詳細については、[完全リファレンス](/gateway/configuration-reference#dm-and-group-access)を参照してください。

  </Accordion>

  <Accordion title="グループチャットのメンションゲーティング設定">
    グループメッセージはデフォルトで**メンション必須**です。エージェントごとにパターンを設定します：

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

    - **メタデータメンション**：ネイティブ@メンション（WhatsAppのタップメンション、Telegramの@botなど）
    - **テキストパターン**：`mentionPatterns`の正規表現パターン
    - チャンネルごとのオーバーライドとセルフチャットモードについては、[完全リファレンス](/gateway/configuration-reference#group-chat-mention-gating)を参照してください。

  </Accordion>

  <Accordion title="セッションとリセットの設定">
    セッションは会話の継続性と分離を制御します：

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

    - `dmScope`：`main`（共有）| `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`：スレッドバインドセッションルーティングのグローバルデフォルト（Discordは`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`をサポート）。
    - スコーピング、IDリンク、送信ポリシーについては、[セッション管理](/concepts/session)を参照してください。
    - すべてのフィールドについては、[完全リファレンス](/gateway/configuration-reference#session)を参照してください。

  </Accordion>

  <Accordion title="サンドボックスの有効化">
    エージェントセッションを隔離されたDockerコンテナで実行します：

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

    最初にイメージをビルドします：`scripts/sandbox-setup.sh`

    完全ガイドについては[サンドボックス](/gateway/sandboxing)を、すべてのオプションについては[完全リファレンス](/gateway/configuration-reference#sandbox)を参照してください。

  </Accordion>

  <Accordion title="ハートビート（定期チェックイン）の設定">
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

    - `every`：期間文字列（`30m`、`2h`）。無効にするには`0m`を設定します。
    - `target`：`last` | `whatsapp` | `telegram` | `discord` | `none`
    - `directPolicy`：`allow`（デフォルト）またはDMスタイルのハートビートターゲット用の`block`
    - 完全ガイドについては[ハートビート](/gateway/heartbeat)を参照してください。

  </Accordion>

  <Accordion title="Cronジョブの設定">
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

    - `sessionRetention`：`sessions.json`から完了した分離実行セッションを削除します（デフォルト`24h`、無効にするには`false`を設定）。
    - `runLog`：サイズと保持行数で`cron/runs/<jobId>.jsonl`を削除します。
    - 機能概要とCLI例については[Cronジョブ](/automation/cron-jobs)を参照してください。

  </Accordion>

  <Accordion title="Webhook（hooks）の設定">
    GatewayでHTTP Webhookエンドポイントを有効にします：

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

    すべてのマッピングオプションとGmail連携については、[完全リファレンス](/gateway/configuration-reference#hooks)を参照してください。

  </Accordion>

  <Accordion title="マルチエージェントルーティングの設定">
    別々のワークスペースとセッションを持つ複数の分離されたエージェントを実行します：

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

    バインディングルールとエージェントごとのアクセスプロファイルについては、[マルチエージェント](/concepts/multi-agent)と[完全リファレンス](/gateway/configuration-reference#multi-agent-routing)を参照してください。

  </Accordion>

  <Accordion title="設定を複数ファイルに分割（$include）">
    大きな設定を整理するために`$include`を使用します：

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

    - **単一ファイル**：含むオブジェクトを置き換えます
    - **ファイルの配列**：順番にディープマージされます（後の方が優先）
    - **兄弟キー**：インクルードの後にマージされます（インクルードされた値を上書き）
    - **ネストされたインクルード**：最大10レベルの深さまでサポートされます
    - **相対パス**：インクルードするファイルからの相対パスで解決されます
    - **エラー処理**：ファイルの欠落、パースエラー、循環インクルードに対する明確なエラー

  </Accordion>
</AccordionGroup>

## 設定ホットリロード

Gatewayは`~/.openclaw/openclaw.json`を監視し、変更を自動的に適用します。ほとんどの設定で手動再起動は不要です。

### リロードモード

| モード                   | 動作                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **`hybrid`**（デフォルト） | 安全な変更を即座にホットアプライ。重要な変更は自動的に再起動します。           |
| **`hot`**              | 安全な変更のみをホットアプライ。再起動が必要な場合は警告をログ出力します。 |
| **`restart`**          | 安全かどうかに関係なく、設定変更時にGatewayを再起動します。                                 |
| **`off`**              | ファイル監視を無効にします。変更は次の手動再起動時に有効になります。                 |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### ホットアプライされるものと再起動が必要なもの

ほとんどのフィールドはダウンタイムなしでホットアプライされます。`hybrid`モードでは、再起動が必要な変更は自動的に処理されます。

| カテゴリ            | フィールド                                                               | 再起動が必要？ |
| ------------------- | -------------------------------------------------------------------- | --------------- |
| チャンネル            | `channels.*`、`web`（WhatsApp）-- すべての組み込みおよび拡張チャンネル | いいえ              |
| エージェント＆モデル      | `agent`、`agents`、`models`、`routing`                               | いいえ              |
| 自動化          | `hooks`、`cron`、`agent.heartbeat`                                   | いいえ              |
| セッション＆メッセージ | `session`、`messages`                                                | いいえ              |
| ツール＆メディア       | `tools`、`browser`、`skills`、`audio`、`talk`                        | いいえ              |
| UI＆その他           | `ui`、`logging`、`identity`、`bindings`                              | いいえ              |
| Gatewayサーバー      | `gateway.*`（port、bind、auth、tailscale、TLS、HTTP）                 | **はい**         |
| インフラストラクチャ      | `discovery`、`canvasHost`、`plugins`                                 | **はい**         |

<Note>
`gateway.reload`と`gateway.remote`は例外です。これらを変更しても再起動はトリガーされ**ません**。
</Note>

## 設定RPC（プログラムによる更新）

<Note>
コントロールプレーン書き込みRPC（`config.apply`、`config.patch`、`update.run`）は`deviceId+clientIp`ごとに**60秒あたり3リクエスト**にレート制限されています。制限された場合、RPCは`retryAfterMs`付きの`UNAVAILABLE`を返します。
</Note>

<AccordionGroup>
  <Accordion title="config.apply（完全置換）">
    設定全体を検証 + 書き込み、1ステップでGatewayを再起動します。

    <Warning>
    `config.apply`は**設定全体を**置き換えます。部分更新には`config.patch`を、単一キーには`openclaw config set`を使用してください。
    </Warning>

    パラメータ：

    - `raw`（文字列）-- 設定全体のJSON5ペイロード
    - `baseHash`（オプション）-- `config.get`からの設定ハッシュ（設定が存在する場合は必須）
    - `sessionKey`（オプション）-- 再起動後のウェイクアップping用セッションキー
    - `note`（オプション）-- 再起動センチネル用のメモ
    - `restartDelayMs`（オプション）-- 再起動前の遅延（デフォルト2000）

    再起動リクエストは保留中/進行中のものがある間は統合され、再起動サイクル間に30秒のクールダウンが適用されます。

    ```bash
    openclaw gateway call config.get --params '{}'  # payload.hashをキャプチャ
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch（部分更新）">
    既存の設定に部分的な更新をマージします（JSONマージパッチセマンティクス）：

    - オブジェクトは再帰的にマージ
    - `null`はキーを削除
    - 配列は置換

    パラメータ：

    - `raw`（文字列）-- 変更するキーのみのJSON5
    - `baseHash`（必須）-- `config.get`からの設定ハッシュ
    - `sessionKey`、`note`、`restartDelayMs` -- `config.apply`と同じ

    再起動動作は`config.apply`と同じです：保留中の再起動の統合と再起動サイクル間の30秒クールダウン。

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 環境変数

OpenClawは親プロセスからの環境変数に加えて以下を読み取ります：

- 現在の作業ディレクトリの`.env`（存在する場合）
- `~/.openclaw/.env`（グローバルフォールバック）

いずれのファイルも既存の環境変数を上書きしません。設定でインライン環境変数を設定することもできます：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="シェル環境インポート（オプション）">
  有効にして期待されるキーが設定されていない場合、OpenClawはログインシェルを実行し、不足しているキーのみをインポートします：

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

環境変数の同等設定：`OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="設定値での環境変数置換">
  任意の設定文字列値で`${VAR_NAME}`を使用して環境変数を参照できます：

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

ルール：

- 大文字の名前のみマッチ：`[A-Z_][A-Z0-9_]*`
- 不足/空の変数はロード時にエラーをスロー
- `$${VAR}`でリテラル出力にエスケープ
- `$include`ファイル内でも動作
- インライン置換：`"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="シークレット参照（env、file、exec）">
  SecretRefオブジェクトをサポートするフィールドでは、以下を使用できます：

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "nano-banana-pro": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/nano-banana-pro/apiKey",
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

SecretRefの詳細（`env`/`file`/`exec`の`secrets.providers`を含む）については、[シークレット管理](/gateway/secrets)を参照してください。
</Accordion>

完全な優先順位とソースについては、[環境](/help/environment)を参照してください。

## 完全リファレンス

フィールドごとの完全なリファレンスについては、**[設定リファレンス](/gateway/configuration-reference)**を参照してください。

---

_関連：[設定例](/gateway/configuration-examples) ・ [設定リファレンス](/gateway/configuration-reference) ・ [Doctor](/gateway/doctor)_
