# Evo Daemon CLI 修正ログ

## 達成したこと

1. **CLIコマンドルーティングの検証**
   - Commander および遅延読み込み(`src/cli/program/command-registry.ts` 等)の挙動を検証した結果、CLIのルーティング構造自体にはバグがなく、正しく `evo daemon` が露出・実行可能であることを確認しました。
   - `error: unknown command 'daemon'` というエラーに直面したのは、コードを修正後にコンパイルステップ(`tsdown` による `dist/` トランスパイル) が正常に完了・反映される前のバイナリから叩いてしまっていたことが原因と考えられます。

2. **ステータスコマンド(Hang)の不具合修正**
   - `node openclaw.mjs evo daemon status` が実行自体は通るものの、結果を出力後になぜか無限にハングしてしまう問題を検知しました。
   - 原因: 内部のリスナーやイベントループがアクティブな状態を維持してしまうため。
   - 修正: `src/cli/evo-cli.ts` の `daemon.command("status")` の末尾に `process.exit(0);` を追加し、出力後に確実に完了してCLIへ制御を返すようにしました。

3. **再コンパイルの実行と稼働検証**
   - `npx tsdown` により `dist/` ディレクトリを最新化。
   - `node openclaw.mjs evo daemon start` をバックグラウンド実行し、正常に無限ループ（Evo Daemonとしての稼働）プロセスに入れることを確認しました。
   - 完了後、ターミナルから `node openclaw.mjs evo daemon status` を叩いて正しいプロセスID・構成診断が即座に出力され、プロセスが安全に終了することを確認しました。

以上の結果を以て、Evo Daemon 周辺のCLIデバッグ目標は全て達成・ブロック解除されました。
