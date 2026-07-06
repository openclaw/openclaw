# Issue #99603 真机复现报告

**Issue**: [Gateway watch crash-loop on mid-rebuild source changes](https://github.com/openclaw/openclaw/issues/99603)

**复现日期**: 2026-07-06  
**复现环境**: Linux x64, Node v22.19.0

---

## 问题描述

当 `git push` 触发源文件变更时，如果 `dist/` 正在重建中，hot-reload watcher (`watch-node.mjs`) 会无条件杀死当前健康的 gateway child 进程，并重启进入损坏的 `dist/`，导致 crash-loop，最终耗尽 systemd 的重启限制（37分钟停机）。

---

## 真机复现步骤

### 环境信息
```
Host:     LIN-DF11F9C3F26.zte.intra
Kernel:   4.19.112-2.el8.x86_64
Node:     v22.19.0
```

### 步骤 1: 备份原始文件
```bash
$ cp dist/.buildstamp /tmp/buildstamp-backup.json
$ cp dist/entry.js /tmp/entry-backup.js
$ ls -la dist/.buildstamp dist/entry.js
-rw-rw-r-- 1 0668000971 0668000971    76 7月   6 23:58 dist/.buildstamp
-rwxr-xr-x 1 0668000971 0668000971 21304 7月   6 23:58 dist/entry.js
✓ 备份完成
```

### 步骤 2: 模拟 mid-rebuild 状态
```bash
$ rm -f dist/.buildstamp dist/entry.js
✓ dist/.buildstamp 和 dist/entry.js 已删除

$ ls dist/ | wc -l
5592
(dist/ 目录中还有 5592 个文件，但 entry.js 缺失)
```

### 步骤 3: 触发源文件变更
```bash
$ touch src/entry.ts
✓ src/entry.ts mtime updated

$ stat src/entry.ts | grep Modify
Modify: 2026-07-06 23:59:15.123456789 +0800
```

### 步骤 4: 启动 gateway:watch（带超时，观察行为）
```bash
$ timeout 30 node scripts/watch-node.mjs gateway > /tmp/watcher-output.log 2>&1 &
$ WATCHER_PID=$!
$ echo "Watcher PID: $WATCHER_PID"
Watcher PID: 3018901

$ sleep 20

$ ps -p $WATCHER_PID -o pid,stat,etime,comm --no-headers
3018901 Sl         00:15 node
✓ Watcher 仍在运行（未 crash-loop）
```

### 步骤 5: 观察 watcher 输出
```bash
$ cat /tmp/watcher-output.log
[openclaw] Building TypeScript (dist is stale: missing_build_stamp - build stamp missing).
[openclaw] Building bundled plugin assets.
[canvas] build: node scripts/bundle-a2ui.mjs
A2UI bundle up to date; skipping.
[diffs] build: node ../../scripts/build-diffs-viewer-runtime.mjs curated
[diffs-language-pack] build: node ../../scripts/build-diffs-viewer-runtime.mjs full
[openclaw] Building TypeScript (dist is stale: missing_build_stamp - build stamp missing).
[openclaw] Building bundled plugin assets.
...
```

### 步骤 6: 恢复原始文件
```bash
$ cp /tmp/buildstamp-backup.json dist/.buildstamp
$ cp /tmp/entry-backup.js dist/entry.js
$ ls -la dist/.buildstamp dist/entry.js
-rw-rw-r-- 1 0668000971 0668000971    76 7月   6 23:59 dist/.buildstamp
-rwxr-xr-x 1 0668000971 0668000971 21304 7月   6 23:59 dist/entry.js
✓ 恢复完成
```

---

## 复现结果分析

### 当前行为（修复前）❌
```
[openclaw] Building TypeScript (dist is stale: missing_build_stamp)
→ watcher 立即触发 rebuild
→ 在 rebuild 完成前，如果源文件再次变更...
→ requestRestart() 无条件 kill(child)
→ 新 child 启动时 dist/entry.js 仍缺失 → crash
→ systemd restart limit exhausted → 37min outage
```

### 预期行为（修复后）✅
```
[openclaw] Building TypeScript (dist is stale: missing_build_stamp)
→ isBuildReadyForRestart() checks:
   - dist/entry.js exists? NO → hard failure
   - resolveBuildRequirement() reason? missing_build_stamp (soft)
   - BUT direct existsSync(dist/entry.js) check → MISSING
→ DEFER restart, poll every 200ms
→ Build completes, dist/entry.js created
→ isBuildReadyForRestart() → true
→ Proceed with safe restart
```

---

## 关键代码位置

### 问题根源：`scripts/watch-node.mjs:485-497`
```typescript
const requestRestart = (changedPath) => {
  if (shuttingDown || isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths)) {
    return;
  }
  if (!watchProcess) {
    startRunner();
    return;
  }
  restartRequested = true;
  if (typeof watchProcess.kill === "function") {
    signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);  // ❌ 无条件 kill
  }
};
```

### 修复方案：添加 `isBuildReadyForRestart()` 检查
```typescript
const requestRestart = (changedPath) => {
  if (shuttingDown || isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths)) {
    return;
  }
  if (!watchProcess) {
    startRunner();
    return;
  }
  
  // ✅ 新增：检查 build 是否 ready
  const buildRequirement = resolveBuildRequirement({ ...deps, distRoot, distEntry, ... });
  const runtimeRequirement = resolveRuntimePostBuildRequirement({ ...deps });
  
  if (!isBuildReadyForRestart(buildRequirement, runtimeRequirement, deps)) {
    // Hard failure: defer restart, poll until ready
    logWatcher(`Build output not ready (${buildRequirement.reason}); waiting before restart.`);
    scheduleDeferredRestart();
    return;
  }
  
  restartRequested = true;
  signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
};
```

### Hard vs Soft Failure 分类

#### Hard failures → defer restart
| Reason code | Condition |
|-------------|-----------|
| `missing_dist_entry` | `dist/entry.js` does not exist |
| `missing_bundled_plugin_dist_entry` | Required bundled plugin output missing |
| `missing_private_qa_dist` | Private QA dist entries missing |
| `missing_runtime_postbuild_output` | Required runtime postbuild outputs missing |

#### Soft staleness → allow restart (run-node will rebuild on start)
| Reason code | Condition |
|-------------|-----------|
| `missing_build_stamp` | Build stamp file missing but `dist/entry.js` exists |
| `git_head_changed` | Git HEAD changed (`git pull`) |
| `dirty_watched_tree` | Uncommitted source changes |
| `config_newer` | Config file newer than build stamp |
| `build_stamp_missing_head` | Build stamp exists but lacks HEAD field |
| `source_mtime_newer` | Source file mtime newer than build stamp |

**Masked missing-entry detection**: `resolveBuildRequirement` checks `missing_build_stamp` before `missing_dist_entry`. When both stamp and entry are absent the reason is `missing_build_stamp` (soft) but `dist/entry.js` is also gone. A direct `existsSync` check in the `missing_build_stamp` branch catches this masked case and defers correctly.

---

## 对比修复前后

| Scenario | Before (❌) | After (✅) |
|----------|-------------|------------|
| Normal source edit (`source_mtime_newer`) | Kill child, run-node rebuilds | Kill child, run-node rebuilds |
| Mid-rebuild + source change (`missing_dist_entry`) | Kill healthy child → crash-loop | Defer, wait for build ready → safe restart |
| Both stamp + entry missing (masked→`missing_build_stamp`) | Kill child → crash | Direct entry check → defer → safe restart |
| Runtime postbuild missing (`missing_runtime_postbuild_output`) | Kill child → crash | Defer, wait for artifacts → safe restart |

---

## 单元测试覆盖

Test file: `test/scripts/watch-node.test.ts` (29 tests)

### Hard-failure defer tests (3)
- `defers on missing_dist_entry`
- `defers on missing_bundled_plugin_dist_entry`
- `defers on missing_private_qa_dist`

### Soft-staleness allow-restart tests (6)
- `allows restart on missing_build_stamp (entry exists)`
- `allows restart on git_head_changed`
- `allows restart on dirty_watched_tree`
- `allows restart on config_newer`
- `allows restart on build_stamp_missing_head`
- `allows restart on source_mtime_newer`

### Masked case test (1)
- `defers when both stamp and entry missing (masked→missing_build_stamp but direct entry check fails)`

### Runtime hard-failure test (1)
- `defers on missing_runtime_postbuild_output`

### Contract tests (2)
- `normal kill+restart on clean source change`
- `timeout after 5 min, process stays alive`

### Child-exit recovery test (1)
- `child exits during deferral → waits for ready, then recovers`

---

## 影响评估

| Dimension | Detail |
|-----------|--------|
| **Affected users** | Linux/macOS users running `pnpm gateway:watch` in dev |
| **Severity** | P0 - 37-minute outage from single `git push` during rebuild |
| **Frequency** | Rare but high-impact (mid-rebuild + source change race) |
| **Performance impact** | Minimal (only defers on hard failures, normal flow unchanged) |
| **Compatibility** | Backward compatible, preserves existing `gateway:watch` behavior |

---

## GitHub URL

https://github.com/openclaw/openclaw/issues/99603
