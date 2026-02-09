---
title: "Skills の作成"
---

# カスタム Skills の作成 🛠

OpenClaw は、容易に拡張できるよう設計されています。「Skills」は、アシスタントに新しい機能を追加するための主要な手段です。 アシスタントに新しい機能を追加する主な方法は「スキル」です。

## Skill とは？

Skill とは、`SKILL.md` ファイル（LLM に指示とツール定義を提供します）を含むディレクトリで、必要に応じてスクリプトやリソースを含めることができます。

## ステップバイステップ：最初の Skill

### 1. ディレクトリを作成する

Skills はワークスペース内、通常は `~/.openclaw/workspace/skills/` に配置されます。Skill 用の新しいフォルダーを作成します。 スキルのために新しいフォルダを作成します:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` を定義する

ディレクトリに `SKILL.md` ファイルを作成します。 そのディレクトリに `SKILL.md` ファイルを作成します。このファイルは、メタデータに YAML フロントマター、指示に Markdown を使用します。

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. ツールを追加する（任意）

フロントマターでカスタムツールを定義するか、エージェントに既存のシステムツール（`bash` や `browser` など）を使用するよう指示できます。

### 4. OpenClaw を更新する

エージェントに「refresh skills」と依頼するか、ゲートウェイを再起動してください。OpenClaw は新しいディレクトリを検出し、`SKILL.md` をインデックスします。 OpenClawは新しいディレクトリを見つけ、`SKILL.md`のインデックスを作成します。

## ベストプラクティス

- **簡潔に**：AI としての振る舞いではなく、「何を」行うかをモデルに指示してください。
- **安全第一**：Skill で `bash` を使用する場合、信頼されていないユーザー入力からの任意のコマンドインジェクションを許可しないよう、プロンプトに注意してください。
- **ローカルでテスト**：`openclaw agent --message "use my new skill"` を使用してテストしてください。

## 共有 Skills

[ClawHub](https://clawhub.com) で Skills を閲覧したり、貢献したりすることもできます。
