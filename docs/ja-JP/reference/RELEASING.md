---
read_when:
    - 公開リリースチャネルの定義を調べたい場合
    - バージョン命名規則とリリース頻度を調べたい場合
summary: 公開リリースチャネル、バージョン命名規則、リリース頻度
title: リリースポリシー
x-i18n:
    generated_at: "2026-04-02T07:51:33Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c6b02d3c773096635de891ffafbbafccd78b45fc4cb39fa6c717d419eee7818c
    source_path: reference/RELEASING.md
    workflow: 15
---

# リリースポリシー

OpenClawには3つの公開リリースレーンがあります：

- stable：npm `latest`に公開されるタグ付きリリースで、`beta`がすでに新しいプレリリースを指していない限り、同じバージョンを`beta`にもミラーします
- beta：npm `beta`に公開されるプレリリースタグ
- dev：`main`の最新ヘッド

## バージョン命名規則

- 安定版リリースバージョン：`YYYY.M.D`
  - Gitタグ：`vYYYY.M.D`
- 安定版修正リリースバージョン：`YYYY.M.D-N`
  - Gitタグ：`vYYYY.M.D-N`
- ベータプレリリースバージョン：`YYYY.M.D-beta.N`
  - Gitタグ：`vYYYY.M.D-beta.N`
- 月や日をゼロ埋めしないこと
- `latest`は現在の安定版npmリリースを意味します
- `beta`は現在のベータインストールターゲットを意味し、アクティブなプレリリースまたは最新のプロモートされた安定版ビルドを指す場合があります
- 安定版および安定版修正リリースはnpm `latest`に公開され、プロモーション後に`beta`がすでに新しいプレリリースを指していない限り、npm `beta`も同じ非ベータバージョンにリタグされます
- すべてのOpenClawリリースはnpmパッケージとmacOSアプリを同時に提供します

## リリース頻度

- リリースはベータ優先で進行します
- 安定版は最新のベータが検証された後にのみリリースされます
- 詳細なリリース手順、承認、認証情報、リカバリーに関する注意事項はメンテナー限定です

## リリース事前チェック

- `pnpm release:check`の前に`pnpm build && pnpm ui:build`を実行して、パック検証ステップに必要な`dist/*`リリースアーティファクトとControl UIバンドルが存在することを確認してください
- タグ付きリリースの前に必ず`pnpm release:check`を実行してください
- 承認前に`RELEASE_TAG=vYYYY.M.D node --import tsx scripts/openclaw-npm-release-check.ts`（または対応するベータ/修正タグ）を実行してください
- npm公開後、`node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.D`（または対応するベータ/修正バージョン）を実行して、新しい一時プレフィックスで公開されたレジストリのインストールパスを検証してください
- メンテナーリリース自動化はプリフライト後プロモート方式を使用するようになりました：
  - 実際のnpm公開は成功したnpm `preflight_run_id`を通過する必要があります
  - 公開の`macOS Release`は検証のみです
  - 実際のプライベートmac公開は成功したプライベートmac `preflight_run_id`と`validate_run_id`を通過する必要があります
  - 実際の公開パスは再ビルドではなく、準備済みアーティファクトをプロモートします
- `YYYY.M.D-N`のような安定版修正リリースでは、公開後検証ツールが`YYYY.M.D`から`YYYY.M.D-N`への同一一時プレフィックスのアップグレードパスもチェックするため、リリース修正によって古いグローバルインストールが基本安定版ペイロードのまま放置されることはありません
- npmリリースプリフライトは、tarballに`dist/control-ui/index.html`と空でない`dist/control-ui/assets/`ペイロードの両方が含まれていない限りクローズド失敗となるため、空のブラウザダッシュボードを再び出荷することはありません
- リリース作業でCI計画、拡張タイミングマニフェスト、または高速テストマトリクスに変更があった場合は、承認前に`node scripts/ci-write-manifest-outputs.mjs --workflow ci`でプランナー管理の`checks-fast-extensions`シャードプランを再生成してレビューし、リリースノートが古いCIレイアウトを記述しないようにしてください
- 安定版macOSリリースの準備状況にはアップデーター関連の確認も含まれます：
  - GitHubリリースにはパッケージ化された`.zip`、`.dmg`、`.dSYM.zip`が含まれている必要があります
  - `main`の`appcast.xml`は公開後に新しい安定版zipを指している必要があります
  - パッケージ化されたアプリは非デバッグバンドルID、空でないSparkleフィードURL、およびそのリリースバージョンの正規Sparkleビルドフロア以上の`CFBundleVersion`を維持する必要があります

## 公開リファレンス

- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)

メンテナーは実際のランブックとして[`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)のプライベートリリースドキュメントを使用します。
