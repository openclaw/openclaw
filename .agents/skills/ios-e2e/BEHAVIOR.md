# Chat behavior harness

`pnpm ios:behavior` measures how the chat transcript moves on the simulator: whether rows jump, drift or rebuild while a reply streams, while the reader is scrolled up, when the keyboard moves, and after a relaunch. It drives the real app against an isolated Gateway whose model is the scripted QA mock, so every run streams the same reply.

## Run it

1. Build the Debug app (`mobilebuildmcp simulator build`). The probe exists only in DEBUG builds.
2. One-time profile, Gateway stopped: `pnpm ios:behavior --setup` writes the `ios-ux` profile (loopback port 19061, token auth, model `mock-openai/gpt-5.6-luna`). It never touches `ios-sim` or `~/.openclaw`.
3. Start two long-running services, the mock first. Wait for it to print its URL before starting the Gateway: `run-node` rebuilds `dist` when it is stale (any new commit), and a Gateway started during that rebuild exits with "Installation replaced".

   ```sh
   OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 node scripts/run-node.mjs qa mock-openai --port 44180
   node openclaw.mjs --profile ios-ux gateway --bind loopback
   ```

4. `pnpm ios:behavior` pairs a fresh simulator through onboarding, runs every case three times, then deletes the simulator and prints a table. `--cases stream-turn,keyboard` and `--samples 1` narrow a run; `IOS_SIM=<udid>` reuses a simulator already paired with `ios-ux`.

   Typing through a UI driver sends hardware key events, after which iOS hides the software keyboard for good. The script therefore resets `HardwareKeyboardLastSeen` in the simulator's `com.apple.keyboard.preferences` while it is shut down, and cases enter prompts by pasting (`simctl pbcopy`, long-press, Paste). Never `type-text` in a case: one `type-text` left every keyboard-up case unable to show the keyboard while this harness was built ([#198293](https://github.com/openclaw/openclaw/pull/198293)).

**Done:** the summary table prints and the script exits 0: every `guard` case passes all gates in every sample, and every `bad` case still reproduces its bug in at least one sample. There is no majority vote: a jump in one sample is a jump users see. Probe logs and `summary.json` land in `.artifacts/ios-behavior/<time>/`.

## What it measures

The chat has two reading policies after a send (`ChatView.handleTimelineChange`): with the keyboard hidden it pins the sent message near the top and the reply grows below it; with the keyboard up it follows the live edge. Each has its own case.

| Case                                                                           | Gates                                                                                                                                                                    | Reported                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `stream-turn`: 300-delta reply sent with the keyboard hidden                   | sent message and reply hold still (≤ 1 pt after the first second, including the live bubble → final row handoff), no teleport (one-frame move > 400 pt), no row remounts | send → own bubble, send → first text, body evaluations                                                         |
| `stream-follow`: the same reply sent with the keyboard up                      | no teleport, backward motion ≤ 1 pt, end in view (≤ 4 pt below the composer), no remounts                                                                                | follow lag p95                                                                                                 |
| `scrolled-up`: reader scrolls up while an 80 s reply streams                   | visible rows drift ≤ 1 pt once the scroll settles, no remounts                                                                                                           | content hidden below                                                                                           |
| `keyboard`: keyboard up and down at the end                                    | gap above the composer within 1 pt of the start, no teleport                                                                                                             | keyboard lift, gaps                                                                                            |
| `relaunch`: cold launch into a session with history, three launches per sample | opens at the end                                                                                                                                                         | launch → composer, launch → rows, shift after first rows, teleports (intermittent on `main`, so reported only) |

Gates are positions and counts; they come out the same on any Mac. Times are simulator wall-clock: compare them A/B against `main` on the same machine, never against a fixed budget. Frame pacing and hitches need a device and Instruments ([DEBUG.md](DEBUG.md)).

A `(setup)` gate failing means the case did not reach its state (keyboard not shown, reply too short to pass the fold, not scrolled away). Fix the setup before reading other gates.

Each case is a `guard` (every gate passes in every sample) or `bad` (reproduces an open bug: setup passes, another gate fails in at least one sample). Two cases are `bad` on `main`: `stream-turn` (the reply shifts 42 pt when its final row replaces the live bubble) and `stream-follow` (with the keyboard up the growing reply is not followed). A fix that makes a `bad` case pass all gates fails the run until the case is changed to `guard` in the same PR. An intermittent bug that does not reproduce reliably stays a reported metric, never a gate: a flaky gate gets retried and ignored.

## How it works

- `ChatBehaviorProbe.swift` (OpenClawChatUI) runs only with `--openclaw-behavior-probe` in a DEBUG build. It writes `Library/Caches/behavior-probe.jsonl` in the app container: each frame where something moved (window-space top and bottom of every tagged row, the live bubble and the composer), mounts, scroll phases, bubble body evaluations, and `send` / `keyboard-show` / `keyboard-hide` marks. "End in view" compares row bottoms with the composer top, not scroll metrics: `LazyVStack` content height is an estimate.
- When a reply finishes, its final row replaces the live bubble; for one frame both exist and the outgoing bubble sits far below. The grader reads the final row as the bubble's continuation and ignores the outgoing one.
- `scripts/lib/ios-behavior-grade.mts` reads the log. Frames inside a user drag or its deceleration are the reader's own motion and are skipped.
- The mock streams `UXSTREAM chunks=<n> interval=<ms>` as `n` markdown deltas `ms` apart, ending in `UX-STREAM-END` (`extensions/qa-lab/src/providers/mock-openai/mock-openai-ux-stream.ts`). Pacing applies to the SSE route the `ios-ux` profile uses; the mock's websocket route sends the deltas at once. The trigger is one all-caps word because the simulator keyboard autocorrects lowercase phrases.

## Add a case

Add an entry to `cases` in `scripts/ios-behavior.mts`: launch into a fresh session key, drive the UI with `mobilebuildmcp`, read the probe, return metrics and gates. Prove a new gate can fail: run it on a build that has the bug (or with the fix reverted) and keep the failing summary as evidence.
