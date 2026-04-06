---
read_when:
    - 認証プロファイルの解決または資格情報ルーティングに取り組んでいるとき
    - モデル認証の失敗やプロファイルの順序をデバッグしているとき
summary: 認証プロファイルの正規の資格情報適格性と解決セマンティクス
title: 認証資格情報セマンティクス
x-i18n:
    generated_at: "2026-04-02T07:29:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: df008fbc4fe7fe2075037786da366b87cf5c67aac0fef90d977157e539991920
    source_path: auth-credential-semantics.md
    workflow: 15
---

# 認証資格情報セマンティクス

このドキュメントは、以下で使用される正規の資格情報適格性と解決セマンティクスを定義します:

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

目標は、選択時とランタイムの動作を一致させることです。

## 安定した理由コード

- `ok`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`

## トークン資格情報

トークン資格情報（`type: "token"`）はインラインの `token` および/または `tokenRef` をサポートします。

### 適格性ルール

1. `token` と `tokenRef` の両方が存在しない場合、トークンプロファイルは不適格です。
2. `expires` は省略可能です。
3. `expires` が存在する場合、`0` より大きい有限の数値でなければなりません。
4. `expires` が無効な場合（`NaN`、`0`、負数、非有限、または不正な型）、プロファイルは `invalid_expires` で不適格になります。
5. `expires` が過去の場合、プロファイルは `expired` で不適格になります。
6. `tokenRef` は `expires` のバリデーションをバイパスしません。

### 解決ルール

1. リゾルバーのセマンティクスは `expires` に関して適格性セマンティクスと一致します。
2. 適格なプロファイルの場合、トークンマテリアルはインライン値または `tokenRef` から解決できます。
3. 解決不能な参照は `models status --probe` の出力で `unresolved_ref` を生成します。

## OAuth SecretRef ポリシーガード

- SecretRef 入力は静的な資格情報専用です。
- プロファイル資格情報が `type: "oauth"` の場合、そのプロファイル資格情報マテリアルに対して SecretRef オブジェクトはサポートされません。
- `auth.profiles.<id>.mode` が `"oauth"` の場合、そのプロファイルに対する SecretRef ベースの `keyRef`/`tokenRef` 入力は拒否されます。
- 違反は起動/リロード時の認証解決パスでハードエラーになります。

## レガシー互換メッセージング

スクリプト互換性のため、プローブエラーは以下の1行目を変更しません:

`Auth profile credentials are missing or expired.`

人間にわかりやすい詳細情報と安定した理由コードは後続の行に追加できます。
