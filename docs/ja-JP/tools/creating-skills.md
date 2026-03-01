---
title: "スキルの作成"
summary: "SKILL.mdを使用してカスタムワークスペーススキルを構築・テストする"
read_when:
  - ワークスペースに新しいカスタムスキルを作成する場合
  - SKILL.mdベースのスキルのクイックスターターワークフローが必要な場合
---

# カスタムスキルの作成

OpenClawは簡単に拡張できるよう設計されています。「スキル」はアシスタントに新しい機能を追加する主な方法です。

## スキルとは？

スキルは `SKILL.md` ファイル（LLMに指示とツール定義を提供する）と、オプションでいくつかのスクリプトやリソースを含むディレクトリです。

## ステップバイステップ: 最初のスキル

### 1. ディレクトリを作成する

スキルはワークスペース（通常 `~/.openclaw/workspace/skills/`）に存在します。スキル用の新しいフォルダを作成してください:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` を定義する

そのディレクトリに `SKILL.md` ファイルを作成します。このファイルはメタデータにYAMLフロントマターを使用し、指示にMarkdownを使用します。

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. ツールを追加する（オプション）

フロントマターでカスタムツールを定義したり、エージェントが既存のシステムツール（`bash` や `browser` など）を使用するよう指示したりできます。

### 4. OpenClawを更新する

エージェントに「スキルを更新して」と頼むか、ゲートウェイを再起動してください。OpenClawは新しいディレクトリを発見して `SKILL.md` をインデックスします。

## ベストプラクティス

- **簡潔にする**: モデルに _何を_ すべきかを指示します。AIとしての振る舞い方ではありません。
- **安全を最優先に**: スキルが `bash` を使用する場合、信頼できないユーザー入力から任意のコマンドインジェクションを許可しないようにプロンプトを設計してください。
- **ローカルでテストする**: `openclaw agent --message "use my new skill"` を使用してテストしてください。

## 共有スキル

[ClawHub](https://clawhub.com) でスキルを閲覧したり、スキルに貢献したりすることもできます。
