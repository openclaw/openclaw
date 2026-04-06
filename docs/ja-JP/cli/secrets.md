---
read_when:
    - ランタイムでシークレット参照を再解決する場合
    - 平文の残留物と未解決の参照を監査する場合
    - SecretRefの設定と一方向スクラブ変更の適用
summary: '`openclaw secrets`（reload、audit、configure、apply）のCLI リファレンス'
title: secrets
x-i18n:
    generated_at: "2026-04-02T07:36:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9047c981289826186134757cb9b3bc966141df29496f1ef507f7fa50b64dd2ef
    source_path: cli/secrets.md
    workflow: 15
---

# `openclaw secrets`

`openclaw secrets` を使用して SecretRef を管理し、アクティブなランタイムスナップショットを健全な状態に保ちます。

コマンドの役割:

- `reload`: Gateway ゲートウェイ RPC（`secrets.reload`）で参照を再解決し、完全に成功した場合のみランタイムスナップショットをスワップします（設定の書き込みは行いません）。
- `audit`: 設定/認証/生成モデルストアおよびレガシー残留物に対する読み取り専用スキャンで、平文、未解決の参照、優先順位のドリフトを検出します（`--allow-exec` が設定されていない限り exec 参照はスキップされます）。
- `configure`: プロバイダーのセットアップ、ターゲットマッピング、プリフライトのための対話型プランナーです（TTY が必要です）。
- `apply`: 保存されたプランを実行します（`--dry-run` で検証のみ。ドライランではデフォルトで exec チェックがスキップされ、書き込みモードでは `--allow-exec` が設定されていない限り exec を含むプランは拒否されます）。その後、対象の平文残留物をスクラブします。

推奨されるオペレーターループ:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

プランに `exec` SecretRef/プロバイダーが含まれている場合は、ドライランと書き込みの両方の apply コマンドに `--allow-exec` を渡してください。

CI/ゲート向けの終了コードに関する注意:

- `audit --check` は検出事項がある場合 `1` を返します。
- 未解決の参照は `2` を返します。

関連:

- シークレットガイド: [シークレット管理](/gateway/secrets)
- 認証情報サーフェス: [SecretRef 認証情報サーフェス](/reference/secretref-credential-surface)
- セキュリティガイド: [セキュリティ](/gateway/security)

## ランタイムスナップショットのリロード

シークレット参照を再解決し、ランタイムスナップショットをアトミックにスワップします。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

注意事項:

- Gateway ゲートウェイ RPC メソッド `secrets.reload` を使用します。
- 解決に失敗した場合、Gateway ゲートウェイは最後に正常だったスナップショットを保持し、エラーを返します（部分的なアクティベーションは行われません）。
- JSON レスポンスには `warningCount` が含まれます。

## 監査

OpenClaw の状態を以下の観点でスキャンします:

- 平文でのシークレット保存
- 未解決の参照
- 優先順位のドリフト（`auth-profiles.json` の認証情報が `openclaw.json` の参照をシャドウイングしている場合）
- 生成された `agents/*/agent/models.json` の残留物（プロバイダーの `apiKey` 値および機密性のあるプロバイダーヘッダー）
- レガシー残留物（レガシー認証ストアエントリ、OAuthリマインダー）

ヘッダー残留物に関する注意:

- 機密性のあるプロバイダーヘッダーの検出は、名前ヒューリスティックに基づきます（`authorization`、`x-api-key`、`token`、`secret`、`password`、`credential` などの一般的な認証/資格情報ヘッダー名およびフラグメント）。

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
openclaw secrets audit --allow-exec
```

終了動作:

- `--check` は検出事項がある場合、非ゼロで終了します。
- 未解決の参照はより高い優先度の非ゼロコードで終了します。

レポート形式のハイライト:

- `status`: `clean | findings | unresolved`
- `resolution`: `refsChecked`、`skippedExecRefs`、`resolvabilityComplete`
- `summary`: `plaintextCount`、`unresolvedRefCount`、`shadowedRefCount`、`legacyResidueCount`
- 検出コード:
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## Configure（対話型ヘルパー）

プロバイダーと SecretRef の変更を対話的に構築し、プリフライトを実行し、オプションで適用します:

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --agent ops
openclaw secrets configure --json
```

フロー:

- 最初にプロバイダーのセットアップ（`secrets.providers` エイリアスの `add/edit/remove`）。
- 次に認証情報のマッピング（フィールドを選択し `{source, provider, id}` 参照を割り当て）。
- 最後にプリフライトとオプションの適用。

フラグ:

- `--providers-only`: `secrets.providers` のみを設定し、認証情報のマッピングをスキップします。
- `--skip-provider-setup`: プロバイダーのセットアップをスキップし、既存のプロバイダーに認証情報をマッピングします。
- `--agent <id>`: `auth-profiles.json` のターゲットディスカバリーと書き込みを1つのエージェントストアにスコープします。
- `--allow-exec`: プリフライト/適用時に exec SecretRef チェックを許可します（プロバイダーコマンドが実行される場合があります）。

注意事項:

- 対話型 TTY が必要です。
- `--providers-only` と `--skip-provider-setup` は組み合わせて使用できません。
- `configure` は `openclaw.json` のシークレットを含むフィールドと、選択されたエージェントスコープの `auth-profiles.json` をターゲットにします。
- `configure` はピッカーフロー内で新しい `auth-profiles.json` マッピングの直接作成をサポートします。
- 正規のサポート対象サーフェス: [SecretRef 認証情報サーフェス](/reference/secretref-credential-surface)。
- 適用前にプリフライト解決を実行します。
- プリフライト/適用に exec 参照が含まれる場合、両方のステップで `--allow-exec` を設定したままにしてください。
- 生成されるプランはデフォルトでスクラブオプションが有効です（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` すべて有効）。
- 適用パスはスクラブされた平文値に対して一方向です。
- `--apply` なしの場合でも、CLI はプリフライト後に「Apply this plan now?」とプロンプトを表示します。
- `--apply` あり（`--yes` なし）の場合、CLI は不可逆であることの追加確認をプロンプトします。

exec プロバイダーの安全性に関する注意:

- Homebrew のインストールでは、多くの場合 `/opt/homebrew/bin/*` 配下にシンボリックリンクされたバイナリが公開されます。
- `allowSymlinkCommand: true` は信頼できるパッケージマネージャーのパスに必要な場合にのみ設定し、`trustedDirs`（例: `["/opt/homebrew"]`）と組み合わせてください。
- Windows では、プロバイダーパスの ACL 検証が利用できない場合、OpenClaw はフェイルクローズします。信頼できるパスに限り、そのプロバイダーに `allowInsecurePath: true` を設定してパスのセキュリティチェックをバイパスできます。

## 保存されたプランの適用

以前に生成されたプランを適用またはプリフライトします:

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

exec の動作:

- `--dry-run` はファイルを書き込まずにプリフライトを検証します。
- ドライランではデフォルトで exec SecretRef チェックがスキップされます。
- 書き込みモードでは `--allow-exec` が設定されていない限り、exec SecretRef/プロバイダーを含むプランを拒否します。
- `--allow-exec` を使用して、いずれのモードでも exec プロバイダーのチェック/実行をオプトインします。

プラン契約の詳細（許可されるターゲットパス、検証ルール、失敗時のセマンティクス）:

- [シークレット適用プラン契約](/gateway/secrets-plan-contract)

`apply` が更新する可能性のあるもの:

- `openclaw.json`（SecretRef ターゲット + プロバイダーの upsert/削除）
- `auth-profiles.json`（プロバイダーターゲットのスクラブ）
- レガシー `auth.json` の残留物
- `~/.openclaw/.env` の既知のシークレットキー（値が移行されたもの）

## ロールバックバックアップがない理由

`secrets apply` は、古い平文値を含むロールバックバックアップを意図的に書き込みません。

安全性は、厳格なプリフライト + アトミックに近い適用と、失敗時のベストエフォートなインメモリ復元によって確保されます。

## 例

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

`audit --check` が依然として平文の検出事項を報告する場合は、報告された残りのターゲットパスを更新し、監査を再実行してください。
