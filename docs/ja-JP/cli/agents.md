---
read_when:
    - 複数の分離されたエージェント（ワークスペース＋ルーティング＋認証）を使用したい場合
summary: '`openclaw agents`のCLIリファレンス（list/add/delete/bindings/bind/unbind/set identity）'
title: agents
x-i18n:
    generated_at: "2026-04-02T07:32:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b6a6b7b9ac330a6eb35dbbb6c080fcca621b6310983534fe7ad10b90e7f0c38c
    source_path: cli/agents.md
    workflow: 15
---

# `openclaw agents`

分離されたエージェント（ワークスペース＋認証＋ルーティング）を管理します。

関連：

- マルチエージェントルーティング：[マルチエージェントルーティング](/concepts/multi-agent)
- エージェントワークスペース：[エージェントワークスペース](/concepts/agent-workspace)

## 使用例

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents bindings
openclaw agents bind --agent work --bind telegram:ops
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## ルーティングバインディング

ルーティングバインディングを使用して、受信チャネルトラフィックを特定のエージェントに固定します。

バインディングの一覧表示：

```bash
openclaw agents bindings
openclaw agents bindings --agent work
openclaw agents bindings --json
```

バインディングの追加：

```bash
openclaw agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

`accountId`を省略した場合（`--bind <channel>`）、OpenClawはチャネルのデフォルトとプラグインセットアップフックから利用可能な場合にそれを解決します。

### バインディングスコープの動作

- `accountId`なしのバインディングは、チャネルのデフォルトアカウントのみに一致します。
- `accountId: "*"`はチャネル全体のフォールバック（全アカウント）であり、明示的なアカウントバインディングよりも優先度が低くなります。
- 同じエージェントに`accountId`なしの一致するチャネルバインディングが既にあり、後から明示的または解決済みの`accountId`でバインドした場合、OpenClawは重複を追加する代わりに既存のバインディングをその場でアップグレードします。

例：

```bash
# 初期のチャネルのみのバインディング
openclaw agents bind --agent work --bind telegram

# 後からアカウントスコープのバインディングにアップグレード
openclaw agents bind --agent work --bind telegram:ops
```

アップグレード後、そのバインディングのルーティングは`telegram:ops`にスコープされます。デフォルトアカウントのルーティングも必要な場合は、明示的に追加してください（例：`--bind telegram:default`）。

バインディングの削除：

```bash
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents unbind --agent work --all
```

## アイデンティティファイル

各エージェントワークスペースのルートに`IDENTITY.md`を配置できます：

- パスの例：`~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity`はワークスペースルート（または明示的な`--identity-file`）から読み取ります

アバターパスはワークスペースルートからの相対パスで解決されます。

## アイデンティティの設定

`set-identity`は`agents.list[].identity`にフィールドを書き込みます：

- `name`
- `theme`
- `emoji`
- `avatar`（ワークスペース相対パス、http(s) URL、またはdata URI）

`IDENTITY.md`から読み込む場合：

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

フィールドを明示的にオーバーライドする場合：

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

設定サンプル：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
