---
title: "リリースチェックリスト"
summary: "npm と macOS アプリのリリース手順のチェックリスト"
read_when:
  - 新しい npm リリースを行うとき
  - 新しい macOS アプリのリリースを行うとき
  - 公開前にメタデータを検証するとき
---

# リリースチェックリスト（npm + macOS）

リポジトリルートから `pnpm`（Node 22+）を使用してください。タグ付け/公開前に作業ツリーをクリーンな状態に保ってください。

## オペレーターのトリガー

オペレーターが「リリース」と言ったら、直ちに次のプリフライトを行ってください（ブロックされない限り追加の質問なし）:

- このドキュメントと `docs/platforms/mac/release.md` を読んでください。
- `~/.profile` から環境変数を読み込み、`SPARKLE_PRIVATE_KEY_FILE` と App Store Connect 変数が設定されていることを確認します（`SPARKLE_PRIVATE_KEY_FILE` は `~/.profile` に配置してください）。
- 必要に応じて `~/Library/CloudStorage/Dropbox/Backup/Sparkle` の Sparkle キーを使用します。

1. **バージョンとメタデータ**

- [ ] `package.json` のバージョンを更新します（例: `2026.1.29`）。
- [ ] `pnpm plugins:sync` を実行して拡張パッケージのバージョンと変更履歴を同期させます。
- [ ] [`src/version.ts`](https://github.com/openclaw/openclaw/blob/main/src/version.ts) の CLI/バージョン文字列と [`src/web/session.ts`](https://github.com/openclaw/openclaw/blob/main/src/web/session.ts) の Baileys ユーザーエージェントを更新します。
- [ ] パッケージメタデータ（name、description、repository、keywords、license）を確認し、`bin` マップが `openclaw` 向けに [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) を指していることを確認します。
- [ ] 依存関係が変更された場合は、`pnpm install` を実行して `pnpm-lock.yaml` を最新の状態にします。

2. **ビルドと成果物**

- [ ] A2UI の入力が変更された場合は `pnpm canvas:a2ui:bundle` を実行し、更新された [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) をコミットします。
- [ ] `pnpm run build`（`dist/` を再生成）。
- [ ] npm パッケージの `files` に必要な `dist/*` フォルダーが含まれていることを確認します（特にヘッドレス node + ACP CLI 用の `dist/node-host/**` と `dist/acp/**`）。
- [ ] `dist/build-info.json` が存在し、期待される `commit` ハッシュが含まれていることを確認します（CLI バナーは npm インストール用にこれを使用します）。
- [ ] 任意: ビルド後に `npm pack --pack-destination /tmp` を実行し、tarball の内容を確認して GitHub リリース用に保管します（コミットしないでください）。

3. **変更履歴とドキュメント**

- [ ] ユーザー向けのハイライトで `CHANGELOG.md` を更新します（ファイルがない場合は作成します）。エントリはバージョンの降順で厳密に管理してください。
- [ ] README の例やフラグが現在の CLI の動作に一致することを確認します（特に新しいコマンドやオプション）。

4. **検証**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test`（カバレッジ出力が必要な場合は `pnpm test:coverage`）
- [ ] `pnpm release:check`（npm パックの内容を検証）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`（Docker インストールスモークテスト、高速パス。リリース前に必須）
  - 直前の npm リリースが既知の破損状態の場合は、preinstall ステップに `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<最後の正常バージョン>` または `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` を設定してください。
- [ ] （任意）フルインストーラースモーク（非 root + CLI カバレッジを追加）: `pnpm test:install:smoke`
- [ ] （任意）インストーラー E2E（Docker、`curl -fsSL https://openclaw.ai/install.sh | bash` を実行し、オンボード後に実際のツール呼び出しを実行）:
  - `pnpm test:install:e2e:openai`（`OPENAI_API_KEY` が必要）
  - `pnpm test:install:e2e:anthropic`（`ANTHROPIC_API_KEY` が必要）
  - `pnpm test:install:e2e`（両方のキーが必要。両方のプロバイダーを実行）
- [ ] （任意）変更が送受信パスに影響する場合は、web Gateway のスポットチェックを行います。

5. **macOS アプリ（Sparkle）**

- [ ] macOS アプリをビルドして署名し、配布用に zip 化します。
- [ ] Sparkle の appcast を生成し（[`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 経由の HTML ノート）、`appcast.xml` を更新します。
- [ ] アプリの zip（オプションの dSYM zip）を GitHub リリースに添付できるよう準備します。
- [ ] 正確なコマンドと必要な環境変数については [macOS リリース](/platforms/mac/release) を参照してください。
  - `APP_BUILD` は数値かつ単調増加である必要があります（`-beta` なし）。Sparkle がバージョンを正しく比較できるようにするためです。
  - 公証を行う場合は、App Store Connect API 環境変数から作成した `openclaw-notary` キーチェーンプロファイルを使用します（[macOS リリース](/platforms/mac/release) を参照）。

6. **公開（npm）**

- [ ] git の状態がクリーンであることを確認し、必要に応じてコミットとプッシュを行います。
- [ ] 必要に応じて `npm login`（2FA を確認）。
- [ ] `npm publish --access public`（プリリリースには `--tag beta` を使用）。
- [ ] レジストリを確認: `npm view openclaw version`、`npm view openclaw dist-tags`、および `npx -y openclaw@X.Y.Z --version`（または `--help`）。

### トラブルシューティング（2.0.0-beta2 リリース時のメモ）

- **npm pack/publish がハングするか巨大な tarball を生成する**: `dist/OpenClaw.app`（およびリリース zip）の macOS アプリバンドルがパッケージに含まれてしまいます。`package.json` の `files` を使って公開内容をホワイトリスト化することで修正してください（dist サブディレクトリ、docs、スキルを含め、アプリバンドルを除外）。`npm pack --dry-run` で `dist/OpenClaw.app` がリストに含まれていないことを確認してください。
- **dist-tags の npm auth ウェブループ**: レガシー認証を使用して OTP プロンプトを取得します:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 検証が `ECOMPROMISED: Lock compromised` で失敗する**: 新しいキャッシュで再試行します:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **遅い修正後にタグの再指定が必要な場合**: タグを強制更新してプッシュし、GitHub リリースのアセットが一致していることを確認します:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub リリース + appcast**

- [ ] タグを付けてプッシュ: `git tag vX.Y.Z && git push origin vX.Y.Z`（または `git push --tags`）。
- [ ] `vX.Y.Z` の GitHub リリースを作成/更新します。**タイトルは `openclaw X.Y.Z`** にしてください（タグのみではなく）。本文にはそのバージョンの**全**変更履歴セクション（Highlights + Changes + Fixes）をインラインで含めます（裸のリンクは不可）。また、**本文内にタイトルを繰り返さないでください**。
- [ ] 成果物を添付: `npm pack` tarball（任意）、`OpenClaw-X.Y.Z.zip`、および `OpenClaw-X.Y.Z.dSYM.zip`（生成された場合）。
- [ ] 更新された `appcast.xml` をコミットしてプッシュします（Sparkle は main からフィードを読み込みます）。
- [ ] クリーンな一時ディレクトリ（`package.json` なし）から `npx -y openclaw@X.Y.Z send --help` を実行して、インストール/CLI エントリポイントが機能することを確認します。
- [ ] リリースノートをアナウンス/共有します。

## プラグイン公開スコープ（npm）

`@openclaw/*` スコープ下で**既存の npm プラグイン**のみを公開します。npm に登録されていないバンドルプラグインは**ディスクツリーのみ**に留まります（`extensions/**` に含まれています）。

リストを導き出すプロセス:

1. `npm search @openclaw --json` を実行してパッケージ名を取得します。
2. `extensions/*/package.json` の名前と比較します。
3. **重複部分**（既に npm に登録済み）のみを公開します。

現在の npm プラグインリスト（必要に応じて更新）:

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

リリースノートには、**デフォルトで有効になっていない新しいオプションのバンドルプラグイン**（例: `tlon`）も記載してください。
