# PR 50051 GitHub Replies

PR: [openclaw/openclaw#50051](https://github.com/openclaw/openclaw/pull/50051)

Use these as exact reply bodies for the current review threads. Each item below is now intended to be **replied to and then resolved**.

## 1. `extensions/executorch/index.ts` bare `require()` in ESM

Comment path: `extensions/executorch/index.ts`

Resolution: **Reply and resolve**

Reply:

```md
Fixed.

`extensions/executorch/index.ts` now uses the existing ESM import for `loadNativeExecuTorchAddon()` instead of calling bare `require()` inside the `gateway_start` hook. That removes the false-negative startup warning path in ESM packages and keeps the preload diagnostic honest.

Regression coverage:

- `pnpm vitest run --config vitest.extensions.config.ts extensions/executorch/index.test.ts`
```

## 2. `extensions/executorch/src/runner-manager.ts` `ensureReady()` concurrent-launch race

Comment path: `extensions/executorch/src/runner-manager.ts`

Resolution: **Reply and resolve**

Reply:

```md
Fixed.

`RunnerManager.ensureReady()` now captures the in-flight launch promise and only clears `readyPromise` if it still owns that same promise, so concurrent callers share one launch instead of starting competing launches. `stop()` no longer clears `readyPromise`, which was the race trigger.

Regression coverage:

- `pnpm vitest run --config vitest.extensions.config.ts extensions/executorch/src/runner-manager.test.ts`
```

## 3. `extensions/executorch/src/runner-manager.ts` redundant `fs.access()` checks

Comment path: `extensions/executorch/src/runner-manager.ts`

Resolution: **Reply and resolve**

Reply:

```md
Fixed.

`validatePaths()` now relies on `resolveFirstExisting()` for the model/tokenizer existence check and only keeps the final direct access pass for paths that were not already probed there. That removes the duplicate filesystem checks and the extra TOCTOU exposure on the success path.

Regression coverage:

- `pnpm vitest run --config vitest.extensions.config.ts extensions/executorch/src/runner-manager.test.ts`
```

## 4. `extensions/executorch/index.ts` allow keyless ExecuTorch media-provider execution

Comment path: `extensions/executorch/index.ts`

Resolution: **Reply and resolve**

Reply:

```md
Fixed.

I added first-class keyless local-provider support in the media-understanding execution path and marked the ExecuTorch provider with `requiresApiKey: false`. That means `executorch` no longer needs a dummy provider key just to pass through generic media-understanding auth gating.

Files touched:

- `src/media-understanding/types.ts`
- `src/media-understanding/runner.entries.ts`
- `extensions/executorch/src/provider.ts`

Regression coverage:

- `pnpm vitest run --config vitest.unit.config.ts src/media-understanding/runner.entries.test.ts`
```

## 5. `apps/macos/Sources/OpenClaw/TalkModeRuntime.swift` reset bridge state after ExecuTorch load failure

Comment path: `apps/macos/Sources/OpenClaw/TalkModeRuntime.swift`

Resolution: **Reply and resolve**

Reply:

```md
Fixed.

Talk Mode now explicitly shuts down the ExecuTorch bridge on model-load failure before falling back to Apple Speech, so the bridge returns to a retryable idle state instead of staying stuck in `.error`. That means users can restore the missing files and retry without restarting the whole app.

Files touched:

- `apps/macos/Sources/OpenClaw/TalkModeRuntime.swift`
- `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`
- `apps/macos/Tests/OpenClawIPCTests/TalkModeRuntimeSpeechTests.swift`

Note: the Swift regression test was added, but `swift test --filter TalkModeRuntimeSpeechTests` is currently blocked in this environment by a transient Sparkle package download timeout during SwiftPM resolution, not by a source test failure.
```

## 6. `extensions/executorch/native/parakeet_runtime_addon.cc` offload inference from the main Node thread

Comment path: `extensions/executorch/native/parakeet_runtime_addon.cc`

Resolution: **Reply and resolve**

Reply:

```md
Fixed in this branch.

The native addon now runs transcription through N-API async work instead of invoking `runner_transcribe()` synchronously on the main Node thread. The TypeScript wrapper was updated to treat addon transcription as async, and the native module was rebuilt successfully after the change.

Verification:

- `pnpm --dir extensions/executorch build:native`
- `pnpm tsgo`
```

## Suggested Thread Order

1. Reply/resolve the three `greptile-apps[bot]` comments first.
2. Reply/resolve the `chatgpt-codex-connector[bot]` keyless-provider comment.
3. Reply/resolve the macOS retryability comment.
4. Reply/resolve the async native-addon comment last.
