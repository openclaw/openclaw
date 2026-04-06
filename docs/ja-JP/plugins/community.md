---
read_when:
    - サードパーティのOpenClawプラグインを探したいとき
    - 自分のプラグインを公開またはリストに掲載したいとき
summary: コミュニティがメンテナンスするOpenClawプラグイン：閲覧、インストール、自作プラグインの提出
title: コミュニティプラグイン
x-i18n:
    generated_at: "2026-04-02T07:48:57Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6be62d948af344ce2f4bcfe2c375ef83bf49f1dfd6605a0faae1b704fc521fc0
    source_path: plugins/community.md
    workflow: 15
---

# コミュニティプラグイン

コミュニティプラグインは、OpenClawに新しいチャネル、ツール、プロバイダー、その他の機能を追加するサードパーティパッケージです。コミュニティによって開発・メンテナンスされ、[ClawHub](/tools/clawhub)またはnpmで公開されており、コマンド1つでインストールできます。

```bash
openclaw plugins install <package-name>
```

OpenClawはまずClawHubを確認し、見つからない場合は自動的にnpmにフォールバックします。

## 掲載プラグイン

### Codex App Server Bridge

Codex App Serverの会話用の独立したOpenClawブリッジ。チャットをCodexスレッドにバインドし、プレーンテキストで会話し、再開、プランニング、レビュー、モデル選択、コンパクション等のチャットネイティブコマンドで制御できます。

- **npm:** `openclaw-codex-app-server`
- **repo:** [github.com/pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server)

```bash
openclaw plugins install openclaw-codex-app-server
```

### DingTalk

Streamモードを使用した企業向けロボット統合。任意のDingTalkクライアント経由でテキスト、画像、ファイルメッセージに対応しています。

- **npm:** `@largezhou/ddingtalk`
- **repo:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

```bash
openclaw plugins install @largezhou/ddingtalk
```

### Lossless Claw (LCM)

OpenClaw用のロスレスコンテキスト管理プラグイン。DAGベースの会話要約とインクリメンタルコンパクションにより、トークン使用量を削減しながら完全なコンテキストの忠実性を維持します。

- **npm:** `@martian-engineering/lossless-claw`
- **repo:** [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Opik

エージェントのトレースをOpikにエクスポートする公式プラグイン。エージェントの動作、コスト、トークン、エラーなどを監視できます。

- **npm:** `@opik/opik-openclaw`
- **repo:** [github.com/comet-ml/opik-openclaw](https://github.com/comet-ml/opik-openclaw)

```bash
openclaw plugins install @opik/opik-openclaw
```

### QQbot

QQ Bot API経由でOpenClawをQQに接続します。プライベートチャット、グループメンション、チャネルメッセージ、音声・画像・動画・ファイルを含むリッチメディアに対応しています。

- **npm:** `@sliverp/qqbot`
- **repo:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

```bash
openclaw plugins install @sliverp/qqbot
```

### wecom

OpenClaw企業向けWeComチャネルプラグイン。
WeCom AI Bot WebSocketの永続接続を活用したボットプラグインで、ダイレクトメッセージとグループチャット、ストリーミング応答、プロアクティブメッセージングに対応しています。

- **npm:** `@wecom/wecom-openclaw-plugin`
- **repo:** [github.com/WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)

```bash
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## プラグインの提出

便利で、ドキュメントが整備され、安全に運用できるコミュニティプラグインを歓迎します。

<Steps>
  <Step title="ClawHubまたはnpmに公開する">
    プラグインは`openclaw plugins install \<package-name\>`でインストール可能である必要があります。
    [ClawHub](/tools/clawhub)（推奨）またはnpmに公開してください。
    完全なガイドは[プラグインの作成](/plugins/building-plugins)を参照してください。

  </Step>

  <Step title="GitHubでホストする">
    ソースコードは、セットアップドキュメントとイシュートラッカーを備えたパブリックリポジトリに置く必要があります。

  </Step>

  <Step title="PRを作成する">
    以下の情報を添えて、このページにプラグインを追加してください：

    - プラグイン名
    - npmパッケージ名
    - GitHubリポジトリURL
    - 一行の説明
    - インストールコマンド

  </Step>
</Steps>

## 品質基準

| 要件                        | 理由                                          |
| --------------------------- | --------------------------------------------- |
| ClawHubまたはnpmで公開済み  | ユーザーが`openclaw plugins install`で利用できる必要がある |
| パブリックGitHubリポジトリ  | ソースレビュー、イシュー追跡、透明性のため   |
| セットアップと使用方法のドキュメント | ユーザーが設定方法を理解できる必要がある      |
| 活発なメンテナンス          | 最近の更新やイシューへの迅速な対応            |

簡易的なラッパー、不明確なオーナーシップ、メンテナンスされていないパッケージは掲載を断る場合があります。

## 関連

- [プラグインのインストールと設定](/tools/plugin) — プラグインのインストール方法
- [プラグインの作成](/plugins/building-plugins) — 自作プラグインの作成
- [プラグインマニフェスト](/plugins/manifest) — マニフェストスキーマ
