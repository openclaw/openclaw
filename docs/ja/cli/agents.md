---
summary: "CLI リファレンス：`openclaw agents`（一覧／追加／削除／ID 設定）"
read_when:
  - 複数の分離されたエージェント（ワークスペース＋ルーティング＋認証）が必要な場合
title: "エージェント"
---

# `openclaw agents`

分離されたエージェント（ワークスペース＋認証＋ルーティング）を管理します。

関連：

- マルチエージェントルーティング：[Multi-Agent Routing](/concepts/multi-agent)
- エージェントワークスペース：[Agent workspace](/concepts/agent-workspace)

## 例

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## ID ファイル

各エージェントワークスペースには、ワークスペースのルートに `IDENTITY.md` を含めることができます。

- 例のパス：`~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` は、ワークスペースのルート（または明示的な `--identity-file`）から読み取ります。

アバターのパスは、ワークスペースのルートを基準に解決されます。

## ID を設定

`set-identity` は、`agents.list[].identity` にフィールドを書き込みます。

- `name`
- `theme`
- `emoji`
- `avatar`（ワークスペース相対パス、http(s) URL、または data URI）

`IDENTITY.md` から読み込みます。

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

フィールドを明示的に上書きします。

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

設定例：

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
