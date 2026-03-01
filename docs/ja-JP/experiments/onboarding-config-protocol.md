---
summary: "オンボーディングウィザードとコンフィグスキーマのRPCプロトコルに関するメモ"
read_when: "オンボーディングウィザードのステップまたはコンフィグスキーマのエンドポイントを変更する場合"
title: "オンボーディングとコンフィグプロトコル"
---

# オンボーディング + コンフィグプロトコル

目的: CLI、macOS アプリ、Web UI 間でオンボーディングとコンフィグの画面を共有するためのものです。

## コンポーネント

- ウィザードエンジン（共有セッション + プロンプト + オンボーディング状態）。
- CLI のオンボーディングは、UI クライアントと同じウィザードフローを使用します。
- Gateway RPC がウィザードとコンフィグスキーマのエンドポイントを公開します。
- macOS のオンボーディングはウィザードのステップモデルを使用します。
- Web UI は JSON Schema と UI ヒントからコンフィグフォームをレンダリングします。

## Gateway RPC

- `wizard.start` パラメータ: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` パラメータ: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` パラメータ: `{ sessionId }`
- `wizard.status` パラメータ: `{ sessionId }`
- `config.schema` パラメータ: `{}`

レスポンス（形状）

- ウィザード: `{ sessionId, done, step?, status?, error? }`
- コンフィグスキーマ: `{ schema, uiHints, version, generatedAt }`

## UI ヒント

- `uiHints` はパスをキーとし、オプションのメタデータ（label/help/group/order/advanced/sensitive/placeholder）を持ちます。
- センシティブなフィールドはパスワード入力としてレンダリングされ、リダクションレイヤーはありません。
- サポートされていないスキーマノードは生の JSON エディタにフォールバックします。

## メモ

- このドキュメントは、オンボーディング/コンフィグのプロトコルリファクタリングを追跡する唯一の場所です。
