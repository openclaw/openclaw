---
read_when:
    - 既存のMatrixインストールをアップグレードする場合
    - 暗号化されたMatrixの履歴とデバイス状態を移行する場合
summary: 以前のMatrixプラグインからのインプレースアップグレード方法（暗号化状態の復元の制限と手動復元手順を含む）
title: Matrix移行
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 69b7530846b977632b699dc3f880841c959c157919fb8115b783eca674a497fb
    source_path: install/migrating-matrix.md
    workflow: 15
---

# Matrix移行

このページでは、以前の公開`matrix`プラグインから現在の実装へのアップグレードについて説明します。

ほとんどのユーザーにとって、アップグレードはインプレースで行われます：

- プラグインは`@openclaw/matrix`のまま
- チャネルは`matrix`のまま
- 設定は`channels.matrix`以下のまま
- キャッシュされた認証情報は`~/.openclaw/credentials/matrix/`以下のまま
- ランタイム状態は`~/.openclaw/matrix/`以下のまま

設定キーの名前変更やプラグインの再インストールは不要です。

## 移行が自動的に行うこと

Gateway ゲートウェイ起動時、および[`openclaw doctor --fix`](/gateway/doctor)を実行した場合、OpenClawは古いMatrix状態を自動的に修復しようとします。
ディスク上の状態を変更するMatrix移行ステップを実行する前に、OpenClawは専用のリカバリースナップショットを作成または再利用します。

`openclaw update`を使用する場合、正確なトリガーはOpenClawのインストール方法によって異なります：

- ソースインストールはアップデートフロー中に`openclaw doctor --fix`を実行し、その後デフォルトでGateway ゲートウェイを再起動
- パッケージマネージャーインストールはパッケージを更新し、非対話型のdoctorパスを実行し、デフォルトのGateway ゲートウェイ再起動に依存してMatrix移行を完了
- `openclaw update --no-restart`を使用した場合、起動時のMatrix移行は後で`openclaw doctor --fix`を実行してGateway ゲートウェイを再起動するまで延期

自動移行でカバーされるもの：

- `~/Backups/openclaw-migrations/`以下の移行前スナップショットの作成または再利用
- キャッシュされたMatrix認証情報の再利用
- 同じアカウント選択と`channels.matrix`設定の保持
- 最も古いフラットなMatrixシンクストアを現在のアカウントスコープの場所に移動
- ターゲットアカウントが安全に解決できる場合、最も古いフラットなMatrix暗号ストアを現在のアカウントスコープの場所に移動
- 古いRust暗号ストアからMatrix部屋キーバックアップの復号化キーを抽出（そのキーがローカルに存在する場合）
- アクセストークンが後で変更された場合、同じMatrixアカウント、ホームサーバー、ユーザーに対して最も完全なトークンハッシュのストレージルートを再利用
- Matrixのアクセストークンは変更されたがアカウント/デバイスのアイデンティティが同じ場合、保留中の暗号化状態の復元メタデータについて兄弟のトークンハッシュストレージルートをスキャン
- 次のMatrix起動時に新しい暗号ストアにバックアップされた部屋キーを復元

スナップショットの詳細：

- OpenClawはスナップショットが成功した後、`~/.openclaw/matrix/migration-snapshot.json`にマーカーファイルを書き込み、後続の起動および修復パスが同じアーカイブを再利用できるようにします。
- これらの自動Matrix移行スナップショットは設定と状態のみをバックアップします（`includeWorkspace: false`）。
- Matrixのエラーメッセージがwarningのみの移行状態（`userId`や`accessToken`がまだ不足しているなど）の場合、Matrix変更はアクション可能でないためOpenClawはスナップショットをまだ作成しません。
- スナップショットステップが失敗した場合、OpenClawはリカバリーポイントなしに状態を変更する代わりに、その実行でのMatrix移行をスキップします。

マルチアカウントアップグレードについて：

- 最も古いフラットなMatrixストア（`~/.openclaw/matrix/bot-storage.json`と`~/.openclaw/matrix/crypto/`）はシングルストアレイアウトから来たため、OpenClawはそれを1つの解決されたMatrixアカウントターゲットにのみ移行できます
- すでにアカウントスコープされたレガシーMatrixストアは、設定されたMatrixアカウントごとに検出・準備されます

## 移行が自動的にできないこと

以前の公開Matrixプラグインはmatrixの部屋キーバックアップを自動的に作成していませんでした。ローカルの暗号状態を保持しデバイス検証を要求しましたが、部屋キーがホームサーバーにバックアップされていることを保証しませんでした。

そのため、一部の暗号化されたインストールは部分的にしか移行できません。

OpenClawが自動的に復元できないもの：

- バックアップされなかったローカルのみの部屋キー
- `homeserver`、`userId`、または`accessToken`がまだ利用できないためにターゲットのMatrixアカウントが解決できない場合の暗号化状態
- `channels.matrix.defaultAccount`が設定されていない場合に複数のMatrixアカウントが設定されているときの1つの共有フラットMatrixストアの自動移行
- 標準のMatrixパッケージの代わりにリポジトリパスに固定されたカスタムプラグインパスのインストール
- 古いストアにバックアップされたキーがあるが復号化キーがローカルに保存されていない場合のリカバリーキーの欠如

現在の警告スコープ：

- カスタムMatrixプラグインパスのインストールは、Gateway ゲートウェイ起動時と`openclaw doctor`の両方で表示されます

古いインストールにバックアップされなかったローカルのみの暗号化履歴があった場合、アップグレード後に古い暗号化メッセージの一部が読めないままになる可能性があります。

## 推奨アップグレードフロー

1. 通常通りOpenClawとMatrixプラグインを更新します。
   起動時にMatrix移行を即座に完了できるよう、`--no-restart`なしの`openclaw update`を使用することを推奨します。
2. 以下を実行：

   ```bash
   openclaw doctor --fix
   ```

   Matrixにアクション可能な移行作業がある場合、doctorはまず移行前スナップショットを作成または再利用し、アーカイブパスを表示します。

3. Gateway ゲートウェイを起動または再起動します。
4. 現在の検証とバックアップの状態を確認：

   ```bash
   openclaw matrix verify status
   openclaw matrix verify backup status
   ```

5. OpenClawがリカバリーキーが必要と通知した場合：

   ```bash
   openclaw matrix verify backup restore --recovery-key "<your-recovery-key>"
   ```

6. このデバイスがまだ未検証の場合：

   ```bash
   openclaw matrix verify device "<your-recovery-key>"
   ```

7. 復元不可能な古い履歴を意図的に放棄し、将来のメッセージのための新しいバックアップベースラインを設定したい場合：

   ```bash
   openclaw matrix verify backup reset --yes
   ```

8. サーバー側のキーバックアップがまだ存在しない場合、将来の復元のために作成：

   ```bash
   openclaw matrix verify bootstrap
   ```

## 暗号化移行の仕組み

暗号化移行は2段階のプロセスです：

1. 起動時または`openclaw doctor --fix`が、暗号化移行がアクション可能な場合に移行前スナップショットを作成または再利用します。
2. 起動時または`openclaw doctor --fix`が、アクティブなMatrixプラグインのインストールを通じて古いMatrix暗号ストアを検査します。
3. バックアップ復号化キーが見つかった場合、OpenClawはそれを新しいリカバリーキーフローに書き込み、部屋キーの復元を保留中としてマークします。
4. 次のMatrix起動時、OpenClawは新しい暗号ストアにバックアップされた部屋キーを自動的に復元します。

古いストアがバックアップされなかった部屋キーを報告した場合、OpenClawは復元が成功したふりをする代わりに警告を表示します。

## よくあるメッセージとその意味

### アップグレードと検出のメッセージ

`Matrix plugin upgraded in place.`

- 意味: 古いオンディスクのMatrix状態が検出され、現在のレイアウトに移行されました。
- 対応: 同じ出力に警告も含まれていない限り、何もする必要はありません。

`Matrix migration snapshot created before applying Matrix upgrades.`

- 意味: OpenClawがMatrix状態を変更する前にリカバリーアーカイブを作成しました。
- 対応: 移行が成功したことを確認するまで、表示されたアーカイブパスを保管してください。

`Matrix migration snapshot reused before applying Matrix upgrades.`

- 意味: OpenClawが既存のMatrix移行スナップショットマーカーを見つけ、重複バックアップを作成する代わりにそのアーカイブを再利用しました。
- 対応: 移行が成功したことを確認するまで、表示されたアーカイブパスを保管してください。

`Legacy Matrix state detected at ... but channels.matrix is not configured yet.`

- 意味: 古いMatrix状態が存在しますが、OpenClawはMatrixが設定されていないため現在のMatrixアカウントにマッピングできません。
- 対応: `channels.matrix`を設定してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Legacy Matrix state detected at ... but the new account-scoped target could not be resolved yet (need homeserver, userId, and access token for channels.matrix...).`

- 意味: OpenClawが古い状態を見つけましたが、正確な現在のアカウント/デバイスルートをまだ決定できません。
- 対応: 動作するMatrixログインでGateway ゲートウェイを一度起動するか、キャッシュされた認証情報が存在した後に`openclaw doctor --fix`を再実行してください。

`Legacy Matrix state detected at ... but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set.`

- 意味: OpenClawが1つの共有フラットMatrixストアを見つけましたが、どの名前付きMatrixアカウントがそれを受け取るべきか推測することを拒否します。
- 対応: `channels.matrix.defaultAccount`を意図するアカウントに設定してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Matrix legacy sync store not migrated because the target already exists (...)`

- 意味: 新しいアカウントスコープの場所にすでにシンクまたは暗号ストアがあるため、OpenClawはそれを自動的に上書きしませんでした。
- 対応: 競合するターゲットを手動で削除または移動する前に、現在のアカウントが正しいアカウントであることを確認してください。

`Failed migrating Matrix legacy sync store (...)` または `Failed migrating Matrix legacy crypto store (...)`

- 意味: OpenClawが古いMatrix状態を移動しようとしましたが、ファイルシステム操作が失敗しました。
- 対応: ファイルシステムのパーミッションとディスク状態を調査してから`openclaw doctor --fix`を再実行してください。

`Legacy Matrix encrypted state detected at ... but channels.matrix is not configured yet.`

- 意味: OpenClawが古い暗号化されたMatrixストアを見つけましたが、それをアタッチする現在のMatrix設定がありません。
- 対応: `channels.matrix`を設定してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Legacy Matrix encrypted state detected at ... but the account-scoped target could not be resolved yet (need homeserver, userId, and access token for channels.matrix...).`

- 意味: 暗号化されたストアが存在しますが、OpenClawはそれが現在のどのアカウント/デバイスに属するかを安全に判断できません。
- 対応: 動作するMatrixログインでGateway ゲートウェイを一度起動するか、キャッシュされた認証情報が利用可能になった後に`openclaw doctor --fix`を再実行してください。

`Legacy Matrix encrypted state detected at ... but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set.`

- 意味: OpenClawが1つの共有フラットレガシー暗号ストアを見つけましたが、どの名前付きMatrixアカウントがそれを受け取るべきか推測することを拒否します。
- 対応: `channels.matrix.defaultAccount`を意図するアカウントに設定してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.`

- 意味: OpenClawが古いMatrix状態を検出しましたが、移行はまだアイデンティティまたは認証情報データの不足でブロックされています。
- 対応: Matrixのログインまたは設定を完了してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Legacy Matrix encrypted state was detected, but the Matrix plugin helper is unavailable. Install or repair @openclaw/matrix so OpenClaw can inspect the old rust crypto store before upgrading.`

- 意味: OpenClawが古い暗号化されたMatrix状態を見つけましたが、通常そのストアを検査するMatrixプラグインのヘルパーエントリーポイントを読み込めませんでした。
- 対応: Matrixプラグインを再インストールまたは修復（`openclaw plugins install @openclaw/matrix`、またはリポジトリチェックアウトの場合は`openclaw plugins install ./path/to/local/matrix-plugin`）してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Matrix plugin helper path is unsafe: ... Reinstall @openclaw/matrix and try again.`

- 意味: OpenClawがプラグインルートを超えるか、プラグイン境界チェックに失敗するヘルパーファイルパスを見つけたため、インポートを拒否しました。
- 対応: 信頼できるパスからMatrixプラグインを再インストールしてから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`- Failed creating a Matrix migration snapshot before repair: ...`

`- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun "openclaw doctor --fix".`

- 意味: OpenClawはリカバリースナップショットを作成できなかったためMatrix状態の変更を拒否しました。
- 対応: バックアップエラーを解決してから`openclaw doctor --fix`を再実行するか、Gateway ゲートウェイを再起動してください。

`Failed migrating legacy Matrix client storage: ...`

- 意味: Matrixクライアント側のフォールバックが古いフラットストレージを見つけましたが、移動が失敗しました。OpenClawは現在、静かに新しいストアで開始する代わりにそのフォールバックを中止します。
- 対応: ファイルシステムのパーミッションや競合を調査し、古い状態を保持したまま、エラーを修正してから再試行してください。

`Matrix is installed from a custom path: ...`

- 意味: Matrixはパスインストールに固定されているため、メインラインの更新は自動的にリポジトリの標準Matrixパッケージに置き換えません。
- 対応: デフォルトのMatrixプラグインに戻したい場合は`openclaw plugins install @openclaw/matrix`で再インストールしてください。

### 暗号化状態復元のメッセージ

`matrix: restored X/Y room key(s) from legacy encrypted-state backup`

- 意味: バックアップされた部屋キーが新しい暗号ストアに正常に復元されました。
- 対応: 通常は何もする必要はありません。

`matrix: N legacy local-only room key(s) were never backed up and could not be restored automatically`

- 意味: 古い部屋キーの一部が古いローカルストアにのみ存在し、Matrixバックアップにアップロードされていませんでした。
- 対応: 別の検証済みクライアントからそれらのキーを手動で復元できない限り、古い暗号化履歴の一部が利用不可のままになることを予期してください。

`Legacy Matrix encrypted state for account "..." has backed-up room keys, but no local backup decryption key was found. Ask the operator to run "openclaw matrix verify backup restore --recovery-key <key>" after upgrade if they have the recovery key.`

- 意味: バックアップは存在しますが、OpenClawはリカバリーキーを自動的に復元できませんでした。
- 対応: `openclaw matrix verify backup restore --recovery-key "<your-recovery-key>"`を実行してください。

`Failed inspecting legacy Matrix encrypted state for account "..." (...): ...`

- 意味: OpenClawが古い暗号化されたストアを見つけましたが、リカバリーを準備するために安全に検査できませんでした。
- 対応: `openclaw doctor --fix`を再実行してください。繰り返す場合は古い状態ディレクトリをそのままにし、別の検証済みMatrixクライアントと`openclaw matrix verify backup restore --recovery-key "<your-recovery-key>"`を使用して復元してください。

`Legacy Matrix backup key was found for account "...", but .../recovery-key.json already contains a different recovery key. Leaving the existing file unchanged.`

- 意味: OpenClawがバックアップキーの競合を検出し、現在のリカバリーキーファイルを自動的に上書きすることを拒否しました。
- 対応: 復元コマンドを再試行する前に、どのリカバリーキーが正しいか確認してください。

`Legacy Matrix encrypted state for account "..." cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.`

- 意味: これは古いストレージ形式の絶対的な限界です。
- 対応: バックアップされたキーは復元できますが、ローカルのみの暗号化履歴は利用不可のままになる可能性があります。

`matrix: failed restoring room keys from legacy encrypted-state backup: ...`

- 意味: 新しいプラグインが復元を試みましたが、Matrixがエラーを返しました。
- 対応: `openclaw matrix verify backup status`を実行し、必要に応じて`openclaw matrix verify backup restore --recovery-key "<your-recovery-key>"`で再試行してください。

### 手動復元のメッセージ

`Backup key is not loaded on this device. Run 'openclaw matrix verify backup restore' to load it and restore old room keys.`

- 意味: OpenClawはバックアップキーがあるはずだと認識していますが、このデバイスではアクティブではありません。
- 対応: `openclaw matrix verify backup restore`を実行するか、必要に応じて`--recovery-key`を渡してください。

`Store a recovery key with 'openclaw matrix verify device <key>', then run 'openclaw matrix verify backup restore'.`

- 意味: このデバイスには現在リカバリーキーが保存されていません。
- 対応: まずリカバリーキーでデバイスを検証してから、バックアップを復元してください。

`Backup key mismatch on this device. Re-run 'openclaw matrix verify device <key>' with the matching recovery key.`

- 意味: 保存されたキーがアクティブなMatrixバックアップと一致しません。
- 対応: 正しいキーで`openclaw matrix verify device "<your-recovery-key>"`を再実行してください。

復元不可能な古い暗号化履歴を失うことを受け入れる場合、代わりに`openclaw matrix verify backup reset --yes`で現在のバックアップベースラインをリセットできます。

`Backup trust chain is not verified on this device. Re-run 'openclaw matrix verify device <key>'.`

- 意味: バックアップは存在しますが、このデバイスはクロス署名チェーンをまだ十分に信頼していません。
- 対応: `openclaw matrix verify device "<your-recovery-key>"`を再実行してください。

`Matrix recovery key is required`

- 意味: 必要なリカバリーキーを指定せずに復元ステップを試みました。
- 対応: リカバリーキーを指定してコマンドを再実行してください。

`Invalid Matrix recovery key: ...`

- 意味: 提供されたキーが解析できないか、期待される形式と一致しませんでした。
- 対応: Matrixクライアントまたはリカバリーキーファイルからの正確なリカバリーキーで再試行してください。

`Matrix device is still unverified after applying recovery key. Verify your recovery key and ensure cross-signing is available.`

- 意味: キーは適用されましたが、デバイスは検証を完了できませんでした。
- 対応: 正しいキーを使用していること、およびアカウントでクロス署名が利用可能であることを確認してから再試行してください。

`Matrix key backup is not active on this device after loading from secret storage.`

- 意味: シークレットストレージはこのデバイスでアクティブなバックアップセッションを生成しませんでした。
- 対応: まずデバイスを検証してから`openclaw matrix verify backup status`で再確認してください。

`Matrix crypto backend cannot load backup keys from secret storage. Verify this device with 'openclaw matrix verify device <key>' first.`

- 意味: このデバイスはデバイス検証が完了するまでシークレットストレージから復元できません。
- 対応: まず`openclaw matrix verify device "<your-recovery-key>"`を実行してください。

### カスタムプラグインインストールのメッセージ

`Matrix is installed from a custom path that no longer exists: ...`

- 意味: プラグインのインストール記録が消えてしまったローカルパスを指しています。
- 対応: `openclaw plugins install @openclaw/matrix`で再インストールするか、リポジトリチェックアウトから実行している場合は`openclaw plugins install ./path/to/local/matrix-plugin`を使用してください。

## 暗号化された履歴が戻らない場合

以下のチェックを順番に実行してください：

```bash
openclaw matrix verify status --verbose
openclaw matrix verify backup status --verbose
openclaw matrix verify backup restore --recovery-key "<your-recovery-key>" --verbose
```

バックアップの復元が成功したが古い部屋の履歴が一部まだ欠けている場合、それらの欠けているキーはおそらく以前のプラグインによってバックアップされていなかったものです。

## 将来のメッセージのためにゼロからやり直したい場合

復元不可能な古い暗号化履歴を失うことを受け入れ、今後のためにクリーンなバックアップベースラインだけが欲しい場合は、以下のコマンドを順番に実行してください：

```bash
openclaw matrix verify backup reset --yes
openclaw matrix verify backup status --verbose
openclaw matrix verify status
```

その後もデバイスが未検証のままの場合は、MatrixクライアントからSAS絵文字または10進数コードを比較して一致していることを確認することでデバイスを検証してください。

## 関連ページ

- [Matrix](/channels/matrix)
- [Doctor](/gateway/doctor)
- [移行](/install/migrating)
- [プラグイン](/tools/plugin)
