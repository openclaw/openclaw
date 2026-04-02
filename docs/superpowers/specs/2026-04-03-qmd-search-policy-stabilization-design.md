# QMD Search Policy Stabilization Design

**Goal:** Shannon の記憶検索を速度・安定性優先に戻し、cheap な自動検索を 1 回だけ許可しつつ、重い `qmd query` は明示時だけに限定する。あわせて、QMD timeout 時に `bun/qmd` 子プロセスが孤児化しないようにして、Mac mini の恒常発熱を再発させない。

## Context

- Shannon の live 設定は現在 `memory.qmd.searchMode = "query"` かつ `timeoutMs = 15000` で、普段の `memory_search` まで重い経路に寄っている。
- OpenClaw の設計上、`memory/*.md` は毎ターン自動注入されず、必要時に `memory_search` / `memory_get` でオンデマンド取得される。
- `qmd query` は BM25 だけでなく vector search / query expansion / reranking を伴う重い経路で、Shannon の「フロント/ルーター」役には過剰。
- 現行の OpenClaw runtime は `searchMode = "search"` でも条件次第で自動的に `qmd query` へフォールバックする。
- 現行の QMD CLI 実行コードは timeout 時にラッパープロセスだけを kill しており、`timeout -> bun -> qmd` の子が孤児化して残る。

## Requirements

### Functional

1. Shannon は 1 ユーザーターンにつき cheap な自動検索を最大 1 回だけ許可する。
2. 重い deep search はユーザー明示時だけ実行する。
3. cheap な検索が失敗しても、自動で `qmd query` へ昇格しない。
4. cheap な QMD 検索が壊れても、memory 機能全体は builtin fallback で継続できる。

### Non-Functional

1. 応答速度・安定性を精度より優先する。
2. timeout 後に `qmd` / `bun` の残留プロセスを作らない。
3. Shannon workspace docs と OpenClaw docs の説明を現実の挙動に合わせる。
4. 既存の explicit deep-search 手段は残す。

## Non-Goals

- QMD 自体の ranking quality 改善や model tuning。
- `memory_search` を完全に無効化すること。
- Shannon 以外のエージェントの検索運用ルールまで一律変更すること。

## Chosen Approach

3 層を同時に直す。

1. **Policy layer:** Shannon の運用ルールを更新し、「cheap auto search は 1 回まで」「2 回目以降の追加検索や deep search はユーザー明示時だけ」を明文化する。
2. **Config layer:** Shannon の live config を `searchMode: "search"` に戻し、search timeout を短縮して普段の recall を cheap path に固定する。
3. **Runtime layer:** OpenClaw source を修正し、`search` / `vsearch` の失敗時に自動で `query` に昇格しないようにする。また timeout 時は process group 単位で停止して孤児化を防ぐ。

## Design

### 1. Shannon Policy

対象:

- `/Users/shannon/.openclaw/workspace/AGENTS.md`
- `/Users/shannon/.openclaw/workspace/tools/memory-stack.md`

方針:

- Shannon の標準フローでは `memory_search` を cheap recall として 1 回だけ使う。
- 1 回の cheap recall で十分な手掛かりがない場合は、勝手に追加検索しない。ユーザーに深掘り許可を求めるか、明示指示を待つ。
- deep search の例は `qmd query` または `memory_search` の deep mode 相当として文書化するが、通常運用からは外す。
- docs 中の「`memory_search` は内部で `qmd query --json`」という説明は削除し、`searchMode` に従う説明へ置き換える。

成功条件:

- Shannon docs を読んだエージェントが、cheap recall と deep search を混同しない。

### 2. Shannon Live Config

対象:

- `/Users/shannon/.openclaw/openclaw.json`

変更:

- `memory.qmd.searchMode: "query"` -> `"search"`
- `memory.qmd.limits.timeoutMs: 15000` -> `4000` か `5000`
- `maxResults = 6` は維持する。ボトルネックは件数より query path の重さだから。

維持:

- `includeDefaultMemory = true`
- `update.interval = "5m"`
- `embedInterval = "30m"`

理由:

- 普段の recall は BM25-only でよい。Shannon は重い検索エンジンではなくルーターなので、まず低遅延で十分なヒットを返すことが重要。

### 3. OpenClaw Runtime

対象:

- `/Users/shannon/repos/openclaw/src/memory/qmd-manager.ts`
- `/Users/shannon/repos/openclaw/src/memory/qmd-process.ts`
- 関連テスト

#### 3.1 Search path policy

現状:

- `searchMode = "search"` や `"vsearch"` でも、フラグ非対応エラー時に自動で `qmd query` にフォールバックする。

変更:

- `searchMode = "search"` または `"vsearch"` のときは、`query` への自動昇格をやめる。
- そのままエラーを投げ、`FallbackMemoryManager` に builtin index への切り替えを任せる。
- `searchMode = "query"` を明示設定した時だけ `qmd query` を使う。

理由:

- 「cheap auto search は 1 回」「heavy search は explicit only」という方針を runtime でも担保するため。
- search path が壊れている環境では、silent に heavy path へ昇格するより builtin fallback へ退避した方が速度・安定性要件に合う。

#### 3.2 Timeout cleanup

現状:

- CLI timeout 時に `child.kill("SIGKILL")` のみを実行している。
- `timeout` ラッパーの内側にいる `bun/qmd` が残りうる。

変更:

- POSIX では QMD CLI を detached な process group として起動し、timeout 時に `process.kill(-pid, "SIGKILL")` でグループ全体を停止する。
- Windows は従来どおり個別 kill を維持する。
- close / error ハンドリングは既存契約を壊さず、timeout エラー文言だけは維持する。

理由:

- 孤児化した `bun/qmd` による長時間 CPU 張り付きの再発を防ぐため。

### 4. Documentation

対象:

- `/Users/shannon/repos/openclaw/docs/reference/memory-config.md`
- `/Users/shannon/.openclaw/workspace/tools/memory-stack.md`
- `/Users/shannon/.openclaw/workspace/AGENTS.md`

変更:

- `memory_search` は `searchMode` に従う、と統一する。
- Shannon の運用 docs では cheap auto search と explicit deep search を分けて記載する。
- OpenClaw docs では、`searchMode = "search"` が cheap path であり、失敗時は builtin fallback へ流れる挙動に合わせて説明を更新する。

## Testing Strategy

### Automated

1. `qmd-manager` の既存テストを更新する。
   - `search` モードでフラグ非対応エラーが出たとき、自動 `query` 昇格をしないこと。
   - その後 `FallbackMemoryManager` 側で builtin index が使われること。
2. `qmd-process` に timeout cleanup のテストを追加する。
   - POSIX では process group kill が走ること。
   - Windows では従来どおり child kill すること。
3. 影響範囲の unit tests を実行する。

### Manual

1. 現在の残留 `bun/qmd` を停止する。
2. Shannon config 反映後、cheap search のみで通常会話が返ることを確認する。
3. 明示 deep-search 指示時だけ `qmd query` が使われる運用に切り替わることを確認する。
4. timeout を意図的に短くしたテストで、残留 `bun/qmd` が出ないことを `ps` で確認する。

## Risks And Mitigations

- **Risk:** 古い QMD build で `search` が使えない。
  - **Mitigation:** automatic `query` 昇格ではなく builtin fallback を使う。memory 機能自体は継続できる。
- **Risk:** detached process group 化でテストが不安定になる。
  - **Mitigation:** 実プロセス生成を直接叩かず、`spawn` / `process.kill` の呼び出し契約を unit test で検証する。
- **Risk:** Shannon docs だけ直して runtime が古いままだと、期待と挙動がズレる。
  - **Mitigation:** local config / local docs / source patch を一つの変更セットとして進める。

## Implementation Scope

この設計の実装は次の順で進める。

1. OpenClaw source の unit test を先に書いて赤にする。
2. runtime を修正してテストを green にする。
3. Shannon の live config と workspace docs を更新する。
4. targeted tests と手動確認で回帰を確認する。
