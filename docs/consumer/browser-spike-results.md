# Browser Spike Results (Week 1)

Last updated: 2026-03-22
Owner: consumer execution team
Status: In progress

## References

- `CONSUMER.md`
- `docs/consumer/openclaw-consumer-execution-spec.md`
- `docs/consumer/CODEX-PROMPT.md`
- `docs/consumer/consumer-execution-tracker.md`

## Baseline snapshot

- Runtime branch: `codex/consumer-browser-improvement`
- Synced base: `consumer` merged with `origin/main` on 2026-03-16
- Browser priority order:
  1. `user` (existing-session / Chrome MCP)
  2. `openclaw` (managed browser profile)
  3. Claude for Chrome extension investigation
  4. Remote browser infra fallback (`Kernel` / `Steel` before paid Browserbase)

## Scoring rubric (fixed)

- Real logged-in session access: 40
- Reliability: 25
- Speed: 15
- Bot protection handling: 10
- Session persistence: 10

## Matrix (2 runs per approach x task, median time)

Legend:

- `PASS`, `FAIL`, `BLOCKED`, `PENDING`

| Approach                  | Task 1 Flight                                          | Task 2 Form          | Task 3 Web Summary                                  | Task 4 X Summary     | Task 5 Multi-step     | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------ | -------------------- | --------------------------------------------------- | -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user` (existing-session) | PASS (median `121.0s`; `r1`: `107.2s`, `r2`: `134.9s`) | PASS (`r1`: `63.1s`) | PASS (median `39.0s`; `r1`: `49.2s`, `r2`: `28.7s`) | FAIL (`r1`: `40.3s`) | FAIL (`r1`: `59.3s`)  | Control lane passes when Chrome exposes standard CDP endpoint (example: launch with `--remote-debugging-port=9333` and attach via browser URL); heavier social/travel flows still time out early                                                                                                           |
| `openclaw` (managed)      | PASS (median `69.9s`; `r1`: `85.4s`, `r2`: `54.5s`)    | PASS (`r1`: `78.8s`) | PASS (median `33.9s`; `r1`: `29.1s`, `r2`: `38.6s`) | PASS (`r1`: `66.5s`) | FAIL (`r1`: `126.2s`) | Control lane passes on clean direct-built gateway (`start`, `status`, `tabs`, `open`); survives more sites than `user` but still times out in long multi-step travel workflows. On Emirates `DPS -> DXB` for `2026-03-22`, this lane failed to keep the booking widget stable long enough to load results. |
| Claude for Chrome         | PENDING                                                | PENDING              | PENDING                                             | PENDING              | PENDING               | Separate category from Anthropic computer-use. It is Chrome-integrated browser control, not generic desktop control, and should be evaluated on its own terms if we can get access and a reproducible test path.                                                                                           |
| Kernel                    | PENDING                                                | PENDING              | PENDING                                             | PENDING              | PENDING               | Next remote-infra lane. Cleaner architecture comparison than Browser Use because it exposes remote browser infrastructure instead of another agent loop.                                                                                                                                                   |
| Browserbase               | FAIL (`r1`: `12.2s`)                                   | PENDING              | FAIL (`r1`: `24.0s`, `r2`: `41.6s`, `r3`: `83.6s`)  | PENDING              | PENDING               | Still relevant for anti-bot/CAPTCHA/Cloudflare, but now a later paid comparison lane because cheaper/free infra lanes should be tested first. Transport is healthy only with fresh `keepAlive: true` sessions; real benchmark tasks still fail deeper in the stack.                                        |

## Current blocker summary

- Browser attach outcome depends on Chrome runtime mode:
  - `openclaw` profile is healthy (`start`, `status`, `tabs`, `open https://example.com` all succeed).
  - `user` existing-session is healthy when Chrome is started with explicit CDP flags and attached via browser URL.
  - `user` existing-session still fails against the current `chrome://inspect` UI-enabled `127.0.0.1:9222` endpoint (`/json/version` returns 404).
- The benchmark-specific runtime now lives at `/tmp/openclaw-consumer-bench`:
  - copied from `/tmp/openclaw-consumer`
  - `channels.telegram.enabled=false`
  - stale `plugins.entries.openai` removed
- Local runner startup blocker is resolved:
  - `agent --local --message 'Reply with exactly OK and nothing else.' --timeout 120` returns `OK` on bench runtime.
- Existing-session findings reproduced outside OpenClaw (direct MCP probe):
  - `chrome-devtools-mcp --autoConnect` against current desktop Chrome: `list_pages` request times out.
  - `chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`: returns error content because `/json/version` is HTTP 404.
  - Launching a separate Chrome with `--remote-debugging-port=9333` exposes standard CDP (`/json/version` works), and OpenClaw `user` lane then passes `status`, `tabs`, and `open`.
- Current benchmark harness findings:
  - The benchmark gateway must run in a persistent terminal session; backgrounding it from a short-lived exec shell causes false "silent exit" failures because the child process gets reaped with the shell.
  - The benchmark runtime must carry `agents/main/agent/auth-profiles.json` and `auth.json`; copying only `openclaw.json` is not enough for `agent --local`.
  - The copied home config was too "live"; a stable benchmark lane requires `bindings=[]` and all chat channels disabled.
  - Existing-session snapshot compatibility patch landed on this branch: selector/frame snapshot requests now degrade to full-page snapshot with a warning instead of failing the call.
  - `profile=user` Task 3 passed; the warning may still appear as compatibility guidance but is no longer a hard error path.
  - The desktop Consumer app owns port `19001`, so the isolated benchmark gateway now runs on `19011` to avoid token mismatches and cross-runtime noise.
  - `profile=openclaw` is currently faster on the completed flight and web-summary tasks, but `profile=user` is now also passing real flight and form tasks on the dedicated CDP Chrome.
  - 2026-03-21 hardening reruns moved the blocker deeper:
    - `profile=user` no longer dies first on browser attach or `new_page`; the latest Emirates rerun instead failed later with `LLM request timed out`.
    - `profile=openclaw` reaches real interaction attempts on Emirates, but still hits repeated-field ambiguity (`Selector "button" matched 248 elements`) plus element interaction timeouts before the flow completes.
  - Browserbase findings on 2026-03-21:
    - Credentials are valid and Browserbase session creation works.
    - Direct OpenClaw browser smoke passes (`status`, `open https://example.com`, `tabs`) when Browserbase sessions are created with `keepAlive: true`.
    - A fresh-session minimal local-agent browser task also passes on Browserbase (`open https://example.com`).
    - Default Browserbase sessions (`keepAlive: false`) are incompatible with OpenClaw's probe/connect pattern because the session dies after disconnect and the next action hits a dead `connectUrl`.
    - Browserbase account currently has a very small concurrent-session cap (`3`), so leaked probe sessions quickly trigger `429 Too Many Requests`.
    - The latest Browserbase Task 3 rerun no longer fails at remote-CDP reachability; it opens the target article and then times out later when the browser tool tries to inspect page contents for summarization.
    - Browserbase Task 1 split rerun shows the same pattern: on a fresh `keepAlive: true` session, direct `status` and `open https://www.google.com/travel/flights` pass first, and the next concrete failure moves downstream to Google Flights field interaction (`locator.fill` timeout) rather than initial remote-CDP attachment.
    - A fresh Browserbase Task 1 rerun on this worktree still fails much earlier on Google Flights with `Remote CDP ... not reachable`, even though a tiny same-session smoke (`open https://example.com`) still passes.
- Browser Use findings on 2026-03-22:
  - Side-lane setup is now complete enough to benchmark without more local environment work:
    - repo-local Browser Use venv created at `.venv-browser-use`
    - pinned Browser Use CLI installed and runnable
    - cloned real-Chrome profile prepared at `/tmp/browser-use-profile4-clone`
    - Browser Use `doctor` passes `4/5` checks
  - Local secrets are no longer the main blocker:
    - local Browser Use `open` now works with `OPENAI_API_KEY` on a fresh profile name
    - Browser Use does not appear to attach directly to the live Chrome root the way OpenClaw's cloned real-Chrome lane does
  - Corrected behavior model:
    - Browser Use local real-browser mode launches Chrome with its own temp `--user-data-dir`
    - the provided `--profile` value becomes the profile directory name inside that temp browser root
    - this means the current CLI path is not a true "use my existing Profile 4 state directly" lane
  - Fresh proof:
    - `browser-use --session fresh1 -b real --headed --profile BrowserUseFresh open https://example.com`
    - result: `PASS`
  - Current blocker split:
    - `Profile 4` still fails early in Browser Use local real-browser mode with `BrowserStartEvent ... timed out after 30.0s`
    - fresh-profile `run` gets further, but the Emirates task currently fails differently: the CLI times out on its local socket wait, and the session is left without a usable root CDP client (`Root CDP client not initialized`)
  - Interpretation:
    - Browser Use itself is not dead; simple local real-browser control works
    - but the current CLI/local-session path is not yet trustworthy for the Emirates benchmark
    - and it should not be described as "cloned real-profile state" because that is not what the local CLI is actually running

- Claude for Chrome findings / correction on 2026-03-22:
  - This should be treated as a separate lane from Anthropic's generic computer-use API.
  - The user is specifically referring to the Chrome extension / Chrome connector path, where Claude operates inside Google Chrome with browser-specific integration.
  - That matters because it is closer to "control Chrome directly" than to generic desktop screenshot+mouse automation.
  - Official references:
    - Anthropic launch note: `https://www.anthropic.com/news/claude-for-chrome/`
    - Claude for Chrome landing page: `https://claude.com/chrome`

- Remote browser infra prioritization update on 2026-03-22:
  - Browserbase should no longer be the first remote infra lane we reach for, because it currently requires paid credits to continue useful testing on this account.
  - Cheaper/free remote infra candidates should be tested before paying for more Browserbase minutes:
    - `Kernel` first if we want to evaluate non-CDP computer-controls + managed auth claims
    - `Steel` first if we want to evaluate session/auth persistence and credentials handling
  - Browserbase still matters if we explicitly want to test Cloudflare Signed Agents / CAPTCHA / anti-bot claims.
  - Kernel prep is now repo-local:
    - dependency added: `@onkernel/sdk`
    - helper added: `scripts/repro/kernel-browser-smoke.sh`
    - first evaluation order:
      1. `doctor`
      2. `smoke-open https://example.com`
      3. `open-emirates`

## Recommended next benchmark set

- Gmail read on a sacrificial test account
  - purpose: signed-in mail UI, auth persistence, hostile/high-value state
- Reddit DM / reply task
  - purpose: hostile logged-in consumer UI, popups, composer behavior, policy constraints
- Google Sign-In on a throwaway account
  - purpose: SSO friction, popup/tab handling, anti-bot/login challenge behavior
- Emirates baseline
  - purpose: keep the already-proven hostile travel benchmark as the reference lane

## Current recommendation

- Primary lane for MVP:
  - OpenClaw real-browser / cloned-real-Chrome state for signed-in and hostile tasks
- Reliability fallback:
  - OpenClaw managed browser
- Side lane only:
  - Browser Use
- Later remote infra comparison:
  - `Kernel` or `Steel` before paying to continue Browserbase
- Real-Chrome findings on 2026-03-21:
  - Chrome will not allow CDP on the user's live default data dir/profile directly; it requires a non-default `--user-data-dir`.
  - The workable compromise is a cloned real-profile lane:
    - source profile detected via `chrome://version`
    - current founder profile: `Profile 4`
    - clone path: throwaway temp dir
    - launch Chrome against the clone with `--remote-debugging-port=9333`
  - This cloned-profile lane preserves real-ish cookies/session state without hijacking the user's day-to-day Chrome runtime.
  - The one-shot repro helper for this lane is `scripts/repro/consumer-user-profile4-clone-emirates.sh`.

Interpretation:

- This is not a gateway/local-runner timeout issue anymore.
- Existing-session instability is currently tied to the current Chrome runtime mode, not OpenClaw gateway routing.
- Benchmark execution can proceed immediately on `openclaw` managed profile while existing-session is being stabilized.

## 2026-03-20 partial benchmark evidence

Artifact root:

- `.artifacts/browser-spike-20260320-114824`

Validated setup:

- benchmark runtime: `/tmp/openclaw-consumer-bench`
- model: `openai-codex/gpt-5.4`
- browser attach for `profile=user`: `OPENCLAW_CHROME_MCP_BROWSER_URL=http://127.0.0.1:9333`
- gateway must stay alive in a persistent terminal session on an isolated port; current benchmark lane uses `19011` because `19001` is owned by the desktop Consumer app runtime

Task 3, runs 1-2:

- `user`
  - result: `PASS`
  - run 1: `49.2s`
  - run 2: `28.7s`
  - median: `39.0s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task3_r1/agent.json`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task3_r2/agent.json`
  - note: run completed, but stderr showed `selector/frame snapshots are not supported for existing-session profiles`
- `openclaw`
  - result: `PASS`
  - run 1: `29.1s`
  - run 2: `38.6s`
  - median: `33.9s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task3_r1/agent.json`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task3_r2/agent.json`
  - note: no matching browser snapshot warning on run 1

Task 1, run 1:

- `user`
  - result: `PASS`
  - run 1: `107.2s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task1_r1/agent.json`
- `openclaw`
  - result: `PASS`
  - run 1: `85.4s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task1_r1/agent.json`

## 2026-03-21 Browserbase compatibility evidence

Artifact roots:

- `.artifacts/browser-spike-20260321-browserbase-smoke`
- `.artifacts/browserbase-fresh-20260321-165522`

Validated setup:

- benchmark runtime: `/tmp/openclaw-consumer-bench`
- model: `openai-codex/gpt-5.4`
- Browserbase session creation: `POST /v1/sessions`
- required provider flag: `keepAlive: true`

Transport proof:

- raw Browserbase session creation succeeds with provided credentials
- raw `playwright-core.connectOverCDP(...)` succeeds immediately against a fresh Browserbase `connectUrl`
- OpenClaw browser CLI smoke succeeds when the Browserbase session is created with `keepAlive: true`
  - `status`: `PASS`
  - `open https://example.com`: `PASS`
  - `tabs`: `PASS`
- OpenClaw local-agent browser-tool smoke also succeeds on the same fresh-session pattern
  - task: open `https://example.com`
  - result: `PASS`
  - artifact: `.artifacts/browserbase-fresh-20260321-165522/agent.json`
- OpenClaw local-agent browser-tool smoke also succeeds from the current worktree/runtime pairing
  - task: open `https://example.com`
  - result: `PASS`
  - artifact: `.artifacts/browserbase-fresh-20260321-4c26-smoke/agent.json`

Critical compatibility rule:

- Browserbase sessions created with the provider default (`keepAlive: false`) are not stable for OpenClaw's attach/probe pattern.
- With `keepAlive: false`, OpenClaw can connect once, then the session is completed and the next action fails on a dead `connectUrl`.
- Browserbase's concurrent-session limit is currently `3`; leaked probe sessions quickly trigger `429 Too Many Requests`.

Task 3, runs 1-3:

- `browserbase`
  - result: `FAIL`
  - run 1: `24.0s`
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task3_r1/agent.json`
  - note: file is polluted by a leading `[browser/service] ...` line, but the payload content is still readable and reports a browser-tool failure: `Remote CDP for profile "browserbase" is not reachable`
  - run 2: `41.6s`
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task3_r2/agent.json`
  - note: second rerun still failed on the old remote-CDP reachability path
  - run 3: `83.6s`
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task3_r3/agent.json`
  - stderr: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task3_r3/agent.stderr.log`
  - note: this rerun opened the target public article successfully, then timed out later when the browser tool attempted to inspect page contents for summarization
  - interpretation: Browserbase transport is proven viable, and the local-agent/browser-tool path can work on fresh sessions; the remaining instability is in deeper browser-tool inspection/snapshot behavior, not initial remote-CDP attachment

Task 1, run 1:

- `browserbase`
  - result: `FAIL`
  - run 1: `12.2s`
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r1/agent.json`
  - stderr: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r1/agent.stderr.log`
  - note: direct Browserbase `status` still passed immediately before the run, but the real Google Flights task failed early with `Remote CDP for profile "browserbase" is not reachable`

Task 1, run 2:

- `user`
  - result: `PASS`
  - run 2: `134.9s`
  - median: `121.0s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task1_r2/agent.json`
- `openclaw`
  - result: `PASS`
  - run 2: `54.5s`
  - median: `69.9s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task1_r2/agent.json`

Browserbase Task 1 split proof, runs 1-2:

- `browserbase`
  - run 1: fresh-session direct task attempt
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r1/agent.json`
  - stderr: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r1/agent.stderr.log`
  - result: `FAIL`
  - note: this run still failed at initial Browserbase remote-CDP reachability on a fresh session
  - run 2: fresh-session split warm-up (`status` + `open`) before agent task
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r2b/direct-status.txt`
  - artifact: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r2b/direct-open.txt`
  - stderr: `.artifacts/browser-spike-20260321-browserbase-smoke/runs/browserbase_task1_r2b/agent.stderr.log`
  - result: `PARTIAL`
  - note: Browserbase transport passed on the same session (`status`, `open https://www.google.com/travel/flights`), and the next concrete blocker became a Google Flights field fill timeout: `TimeoutError: locator.fill: Timeout 5000ms exceeded` while waiting on `locator('aria-ref=ax194')`

Task 2, run 1:

- `user`
  - result: `PASS`
  - run 1: `63.1s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task2_r1/agent.json`
  - note: concrete public test target used: `https://www.selenium.dev/selenium/web/web-form.html`
- `openclaw`
  - result: `PASS`
  - run 1: `78.8s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task2_r1/agent.json`
  - note: concrete public test target used: `https://www.selenium.dev/selenium/web/web-form.html`

Task 4, run 1:

- `user`
  - result: `FAIL`
  - run 1: `40.3s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task4_r1/agent.json`
  - note: opening the requested X post timed out immediately and the browser tool advised not to retry
- `openclaw`
  - result: `PASS`
  - run 1: `66.5s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task4_r1/agent.json`
  - note: requested post URL looked unavailable, so the run fell back to another visible public `@OpenAI` post and summarized that instead

Supplemental real-site commerce smoke, early read:

- `user` on Emirates booking flow:
  - result: `FAIL`
  - run 1: `44.9s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task6_r1/agent.json`
  - note: `emirates.com` timed out on the initial open step
- `openclaw` on Emirates booking flow:
  - status: `INCOMPLETE`
  - note: run 1 reached the booking form, then hit selector ambiguity on repeated airport fields before a clean completion/failure summary was produced; run 2 used an explicit screenshot/snapshot-first prompt and avoided the immediate selector failure, but still did not finish cleanly inside the benchmark window

## 2026-03-21 Emirates comparison: cloned real Chrome vs managed browser

Task:

- one-way `Denpasar (DPS) -> Dubai (DXB)`
- date: `2026-03-22`
- stop when visible flight options load

Cloned real-Chrome lane (`user`, cloned `Profile 4`):

- result: `PASS`
- run time: `127.0s`
- launch mode:
  - clone real profile into a throwaway `--user-data-dir`
  - launch Chrome with `--remote-debugging-port=9333`
  - attach OpenClaw `profile=user` to that CDP endpoint
- artifact summary:
  - visible page showed `Choose your outbound flight`
  - `Sunday, 22 March 2026`
  - `(5 options)`
  - top visible nonstop options:
    - `EK399`, `B777`, `00:25 -> 05:45`, `9h 20m`, `IDR 8,053,600`
    - `EK369`, `A380`, `19:50 -> 01:10+1`, `9h 20m`, `IDR 8,053,600`
  - slower one-stop options were visible below and marked worse or sold out
- interpretation:
  - cloned real-Chrome state currently beats the managed `openclaw` browser on this travel site
  - this is the closest working version of the intended "use my real browser state" architecture

Managed browser lane (`openclaw`):

- result: `FAIL`
- run time: `169.3s`
- artifact summary:
  - initial click/fill attempts timed out
  - booking widget became unstable
  - page regressed to the static `Book a flight` / `How to book a flight ticket with Emirates` content
  - no safe visible result list loaded
- interpretation:
  - this lane is still viable for some sites, but on Emirates it is currently worse than the cloned real-Chrome lane

## 2026-03-21 hardening reruns

Artifact root:

- `.artifacts/browser-spike-20260321-emirates-clean`

Validated setup:

- benchmark runtime: `/tmp/openclaw-consumer-bench`
- gateway: `ws://127.0.0.1:19011`
- browser control: `http://127.0.0.1:19013`
- `profile=user` attach target: `OPENCLAW_CHROME_MCP_BROWSER_URL=http://127.0.0.1:9333`
- screenshots/snapshots were explicitly required before each major step

Hardening verified before reruns:

- isolated bench sessions no longer reuse stale absolute `sessionFile` paths from the shared Consumer app runtime
- browser availability/status checks were widened so healthy browsers stop being marked unavailable too aggressively
- existing-session `new_page` forwards the larger timeout budget and now gets past the old early-navigation failure mode
- existing-session action tools (`click`, `fill`, `fill_form`, `hover`, `drag`, `press`) now forward `timeoutMs` instead of silently falling back to a short default

Emirates rerun status:

- `user`
  - artifact: `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_final_r2/`
  - result: `FAIL`
  - note: this rerun no longer failed on browser attach or the first `new_page`; it failed later with repeated `LLM request timed out`, so the active blocker shifted from browser transport to model/runtime completion on the heavy prompt
  - latest spot check: `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_final_r3/`
  - latest spot-check note: the lane is still non-deterministic; a fresh rerun regressed to `Chrome MCP attach timed out for profile "user" after 15000ms`
- `openclaw`
  - artifact: `.artifacts/browser-spike-20260321-emirates-clean/runs/openclaw_task6_final/`
  - result: `FAIL`
  - note: browser actions progressed further than before, but the run still collapsed under real booking-page ambiguity and interaction limits (`Selector "button" matched 248 elements`, `locator.fill: Timeout 5000ms exceeded`, `locator.click: Timeout 5000ms exceeded`)

Current read:

- `profile=user` is materially healthier than it was on 2026-03-20, but the Emirates end-to-end is still non-deterministic: one rerun reached model/runtime timeout after getting past earlier browser failures, while a later spot check still regressed to attach timeout.
- `profile=openclaw` remains the more reliable interaction baseline, but still needs better repeated-field disambiguation for real commerce/travel sites.

Proof-oriented reruns (same task, stricter stop-and-prove prompt):

- `user`
  - artifact: `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_proof_r8/agent.json`
  - result: `FAIL`
  - duration: `107.7s`
  - note: this rerun did not reach passenger details or payment. It stopped on the visible `Flights to London (LON)` booking widget with validation text including `Please fill all mandatory fields` and `Please choose a departure date`, while the visible button remained `Search flights`.
- `openclaw`
  - artifact: `.artifacts/browser-spike-20260321-emirates-clean/runs/openclaw_task6_proof_r1/agent.json`
  - result: `FAIL`
  - duration: `235.1s`
  - note: this rerun got farther than `user`, reaching the visible `Book a flight` multi-city form with visible `Flight 1` / `Flight 2` sections and one departure date set to `21 Mar 26`, but it still failed before passenger details because Emirates airport autocomplete/selection remained unresolved (`Please choose a destination`, `Please choose an origin`).

Corrected interpretation after proof reruns:

- The earlier `user_task6_final_r7` `PASS` is not strong enough to claim passenger-details progress. The stronger proof-oriented rerun contradicted it.
- Neither browser lane currently has proof that it reached passenger details or payment on Emirates.
- `openclaw` currently appears to get farther than `user` on this exact hostile commerce flow, but it still does not complete the safe pre-payment path.

Task 5, run 1:

- `user`
  - result: `FAIL`
  - run 1: `59.3s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/user_task5_r1/agent.json`
  - note: failed on the first page open while trying to start the flight search/comparison flow
- `openclaw`
  - result: `FAIL`
  - run 1: `126.2s`
  - artifact: `.artifacts/browser-spike-20260320-114824/runs/openclaw_task5_r1/agent.json`
  - note: opened the flight search page, but a later required snapshot timed out before the compare-and-open-details flow could finish

## Command-level benchmark runbook (week 1)

This runbook is for current mainline browser architecture only:

- `profile=user` (Chrome existing-session via MCP)
- `profile=openclaw` (OpenClaw-managed isolated browser)

### 0) Preflight and artifact root

```bash
cd ~/Programming_Projects/openclaw
git checkout consumer
pnpm install && pnpm build

export OPENCLAW_HOME=/tmp/openclaw-consumer
export OPENCLAW_PROFILE=consumer-test
export OPENCLAW_GATEWAY_PORT=19001
export RUN_ROOT="$PWD/.artifacts/browser-spike/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_ROOT"/{logs,prompts,runs}

oc() {
  OPENCLAW_HOME="$OPENCLAW_HOME" \
  OPENCLAW_PROFILE="$OPENCLAW_PROFILE" \
  OPENCLAW_GATEWAY_PORT="$OPENCLAW_GATEWAY_PORT" \
  pnpm openclaw "$@"
}

now_ms() { node -e 'console.log(Date.now())'; }
```

### 1) Gateway startup and health

```bash
oc gateway run --port 19001 --bind loopback >"$RUN_ROOT/logs/gateway.log" 2>&1 &
export GATEWAY_PID=$!
echo "$GATEWAY_PID" >"$RUN_ROOT/logs/gateway.pid"
sleep 4

oc gateway status --deep --require-rpc --json >"$RUN_ROOT/logs/gateway-status.json"
oc channels status --probe --json >"$RUN_ROOT/logs/channels-probe.json"
```

If `19001` is already used by another active gateway, pick a different isolated port for the benchmark run instead of using `--force`.

### 2) Browserbase credential check and blocked-state mark

Do this before any signup flow.

```bash
grep -nEi "browserbase|connect\\.browserbase\\.com|BROWSERBASE_API_KEY|apiKey=" \
  ~/.openclaw/openclaw.json \
  ~/.openclaw-consumer-test/openclaw.json \
  "$OPENCLAW_HOME/openclaw.json" \
  2>/dev/null | tee "$RUN_ROOT/logs/browserbase-config-hits.txt"

if [ ! -s "$RUN_ROOT/logs/browserbase-config-hits.txt" ]; then
  echo "credential-blocked" > "$RUN_ROOT/logs/browserbase-status.txt"
  printf "Browserbase\tcredential-blocked\tno creds in config\n" >> "$RUN_ROOT/logs/benchmark-status.tsv"
fi
```

Keep Browserbase cells in the matrix as `BLOCKED` and notes as `credential-blocked` until credentials are provided.

### 3) Profile readiness

`profile=user` requires local Chrome running with remote debugging enabled at `chrome://inspect/#remote-debugging`.

```bash
open -a "Google Chrome" || true

oc browser --json --browser-profile user start >"$RUN_ROOT/logs/user-start.json" || true
oc browser --json --browser-profile user status >"$RUN_ROOT/logs/user-status.json" || true
oc browser --json --browser-profile user tabs >"$RUN_ROOT/logs/user-tabs.json" || true

oc browser --json --browser-profile openclaw start >"$RUN_ROOT/logs/openclaw-start.json"
oc browser --json --browser-profile openclaw status >"$RUN_ROOT/logs/openclaw-status.json"
oc browser --json --browser-profile openclaw tabs >"$RUN_ROOT/logs/openclaw-tabs.json"
```

### 4) Task prompt files

```bash
cat >"$RUN_ROOT/prompts/task1-flight.txt" <<'EOF'
Search flights NYC -> London in April and compare top 3 options by total price and duration.
EOF

cat >"$RUN_ROOT/prompts/task2-form.txt" <<'EOF'
Open a real signup or booking-style form and fill it with clearly fake test data without submitting payment.
EOF

cat >"$RUN_ROOT/prompts/task3-web-summary.txt" <<'EOF'
Open a public article URL and return a concise summary with 5 key points.
EOF

cat >"$RUN_ROOT/prompts/task4-x-summary.txt" <<'EOF'
Open an X/Twitter post and summarize the main point plus any linked context.
EOF

cat >"$RUN_ROOT/prompts/task5-multistep.txt" <<'EOF'
Run a multi-step flow: search, compare 3 results, then take one action (save, add to cart, or equivalent non-destructive action).
EOF
```

### 5) Timed run harness (per-task runs + evidence capture)

```bash
capture_failure() {
  local profile="$1"
  local run_dir="$2"
  oc browser --json --browser-profile "$profile" status >"$run_dir/fail.status.json" || true
  oc browser --json --browser-profile "$profile" tabs >"$run_dir/fail.tabs.json" || true
  oc browser --browser-profile "$profile" snapshot --format ai --limit 800 --out "$run_dir/fail.snapshot.ai.txt" || true
  oc browser --browser-profile "$profile" screenshot --full-page >"$run_dir/fail.screenshot.txt" 2>&1 || true
  oc browser --json --browser-profile "$profile" console --level error >"$run_dir/fail.console.json" || true
  oc browser --json --browser-profile "$profile" errors >"$run_dir/fail.errors.json" || true
  oc browser --json --browser-profile "$profile" requests >"$run_dir/fail.requests.json" || true
  oc logs --json --limit 400 >"$run_dir/fail.gateway-log-tail.json" || true
}

run_case() {
  local profile="$1"
  local task_id="$2"
  local run_no="$3"
  local task_file="$4"
  local run_id="${profile}_${task_id}_r${run_no}"
  local run_dir="$RUN_ROOT/runs/$run_id"
  mkdir -p "$run_dir"

  oc browser --browser-profile "$profile" trace start --sources >"$run_dir/trace-start.txt" 2>&1 || true

  local task_text
  task_text="$(cat "$task_file")"
  local prompt
  prompt=$'Week-1 browser benchmark run.\nUse browser tool only with profile="'"$profile"$'".\nDo not switch profiles.\nReturn exactly:\nRESULT: PASS or FAIL\nSUMMARY: one paragraph\n\nTask:\n'"$task_text"
  printf "%s\n" "$prompt" >"$run_dir/prompt.txt"

  local start_ms end_ms duration_ms exit_code
  start_ms="$(now_ms)"
  oc agent --local --agent main --json --message "$prompt" >"$run_dir/agent.json" 2>"$run_dir/agent.stderr.log"
  exit_code=$?
  end_ms="$(now_ms)"
  duration_ms=$((end_ms - start_ms))

  oc browser --browser-profile "$profile" trace stop --out "$run_dir/trace.zip" >"$run_dir/trace-stop.txt" 2>&1 || true
  oc browser --json --browser-profile "$profile" status >"$run_dir/post.status.json" || true
  oc browser --json --browser-profile "$profile" tabs >"$run_dir/post.tabs.json" || true
  oc browser --browser-profile "$profile" screenshot --full-page >"$run_dir/post.screenshot.txt" 2>&1 || true

  printf "%s\t%s\t%s\t%s\t%s\n" "$profile" "$task_id" "$run_no" "$duration_ms" "$exit_code" >> "$RUN_ROOT/timings.tsv"
  if [ "$exit_code" -ne 0 ]; then
    capture_failure "$profile" "$run_dir"
  fi
}
```

### 6) Execute full matrix (2 runs x 5 tasks x 2 profiles)

```bash
for profile in user openclaw; do
  run_case "$profile" task1 1 "$RUN_ROOT/prompts/task1-flight.txt"
  run_case "$profile" task1 2 "$RUN_ROOT/prompts/task1-flight.txt"
  run_case "$profile" task2 1 "$RUN_ROOT/prompts/task2-form.txt"
  run_case "$profile" task2 2 "$RUN_ROOT/prompts/task2-form.txt"
  run_case "$profile" task3 1 "$RUN_ROOT/prompts/task3-web-summary.txt"
  run_case "$profile" task3 2 "$RUN_ROOT/prompts/task3-web-summary.txt"
  run_case "$profile" task4 1 "$RUN_ROOT/prompts/task4-x-summary.txt"
  run_case "$profile" task4 2 "$RUN_ROOT/prompts/task4-x-summary.txt"
  run_case "$profile" task5 1 "$RUN_ROOT/prompts/task5-multistep.txt"
  run_case "$profile" task5 2 "$RUN_ROOT/prompts/task5-multistep.txt"
done
```

### 7) Median timing extract + teardown

```bash
node - "$RUN_ROOT/timings.tsv" <<'NODE' > "$RUN_ROOT/timings-median.tsv"
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n")
  .map((line) => line.split("\t"))
  .filter((cols) => cols.length === 5);
const byKey = new Map();
for (const [profile, task, runNo, durationMs, exitCode] of rows) {
  const key = `${profile}\t${task}`;
  const item = byKey.get(key) ?? [];
  item.push({ runNo: Number(runNo), durationMs: Number(durationMs), exitCode: Number(exitCode) });
  byKey.set(key, item);
}
for (const [key, vals] of [...byKey.entries()].sort()) {
  const d = vals.map((v) => v.durationMs).sort((a, b) => a - b);
  const median = d.length % 2 ? d[(d.length - 1) / 2] : Math.round((d[d.length / 2 - 1] + d[d.length / 2]) / 2);
  const exitSummary = vals.map((v) => v.exitCode).join(",");
  console.log(`${key}\t${median}\t${exitSummary}`);
}
NODE

kill "$GATEWAY_PID" 2>/dev/null || true
```

### OAuth callback recovery note

If `models auth login --provider openai-codex --method oauth` lands on a `State mismatch` page:

1. Close every existing OpenAI/Codex auth tab in the browser.
2. Check whether anything is still listening on `127.0.0.1:1455`.
3. Kill the stale `openclaw-models` / auth listener process if one is still bound there.
4. Rerun the login from a single fresh terminal session.

That sequence cleared the repeated mismatch for this worktree.

### 8) Failure evidence checklist (required when a run fails)

- `runs/<run_id>/prompt.txt`
- `runs/<run_id>/agent.json` and `agent.stderr.log`
- `runs/<run_id>/trace.zip`
- `runs/<run_id>/fail.snapshot.ai.txt`
- `runs/<run_id>/fail.screenshot.txt`
- `runs/<run_id>/fail.console.json`
- `runs/<run_id>/fail.errors.json`
- `runs/<run_id>/fail.requests.json`
- `runs/<run_id>/fail.gateway-log-tail.json`

## Run log

### 2026-03-16 - Phase A smoke evidence

Commands:

```bash
pnpm install
pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway --port 19001 --bind loopback --allow-unconfigured
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user tabs
```

Observed:

- `channels status --probe`: gateway reachable on `19001`
- `browser --browser-profile openclaw status`: PASS
- `browser --browser-profile user status|tabs`: FAIL
  - error: `Could not connect to Chrome. Could not find DevToolsActivePort ...`
  - implication: existing-session attach path is blocked on Chrome-side readiness/config

### 2026-03-16 - Existing-session readiness retest

Commands:

```bash
open -a "Google Chrome"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user tabs
```

Observed:

- `user start`: returned error path tied to missing `DevToolsActivePort`
- `user status|tabs`: still FAIL with same error
- conclusion: we need explicit Chrome MCP readiness setup (remote debugging/doctor migration), not just launching Chrome app

### 2026-03-16 - Existing-session root cause (confirmed)

Commands:

```bash
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
open -na "Google Chrome" --args --remote-debugging-port=9222
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
```

Observed:

- `DevToolsActivePort` is missing before and after launching Chrome with `--remote-debugging-port`.
- `browser --browser-profile user status` fails with:
  - `Could not connect to Chrome. Check if Chrome is running.`
  - `Cause: Could not find DevToolsActivePort ...`
- This confirms the blocker is Chrome-side existing-session readiness, not OpenClaw browser profile mapping.

### 2026-03-16 - Managed profile gateway-stability blocker

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw start --json
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw tabs --json
```

Observed:

- Probe shows `Gateway reachable`.
- `openclaw start` succeeds and reports `running=true`, `cdpReady=true`.
- Immediate follow-up `openclaw tabs` can fail with:
  - `gateway closed (1006 abnormal closure (no close frame))`
- Full matrix run stayed blocked because gateway process lifetime was unstable in this CLI automation environment.

### 2026-03-16 - LaunchAgent lane mismatch (not suitable for isolated runtime)

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway install --port 19001 --bind loopback
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway start
launchctl print gui/$UID/ai.openclaw.consumer-test
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
```

Observed:

- LaunchAgent starts and listens on `19001`.
- Runtime identity in logs is `stateDir=/Users/user/.openclaw` (not `/tmp/openclaw-consumer/.openclaw`).
- Probe from isolated runtime times out because auth/state do not match isolated config.
- Result: LaunchAgent flow is unsuitable for this benchmark's isolated state model; reverted with `gateway stop` + `gateway uninstall`.

### 2026-03-16 - Harness validation error (command shape)

Commands:

```bash
cat .artifacts/browser-spike/20260316-184600-openclaw-pass1/runs/openclaw_task1_r1/agent.stderr.log
pnpm openclaw agent --help
```

Observed:

- Harness used `oc agent --local --json --message ...` and failed with:
  - `Error: Pass --to <E.164>, --session-id, or --agent to choose a session`
- Benchmark harness must include explicit routing (`--agent`, `--session-id`, or `--to`) for each run.

### 2026-03-16 - Consumer profile bootstrap fix

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw doctor --non-interactive
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw config set gateway.mode local
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway --port 19001 --bind loopback
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
```

Observed:

- `doctor` identified unset `gateway.mode` as startup blocker for non-allow-unconfigured runs.
- After setting `gateway.mode=local`, gateway starts cleanly on `19001` without `--allow-unconfigured`.
- Probe remains PASS (`Gateway reachable`).

### 2026-03-17 - Control-lane retest after Chrome remote debugging enablement

Commands:

```bash
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user tabs
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw tabs
```

Observed:

- `DevToolsActivePort` exists and reports `9222`.
- All control-lane commands succeeded (`probe=0 user_start=0 user_status=0 user_tabs=0 open_start=0 open_status=0 open_tabs=0`).
- Evidence bundle: `.artifacts/browser-spike/20260317-140720-post-remote-debug/`.

### 2026-03-17 - Local agent-turn blocker after lane recovery

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw agent --local --agent main --timeout 90 --json --message "Use browser with profile user. Open a snapshot and reply exactly: RESULT: PASS"
```

Observed:

- First failure was missing isolated auth profile (`No API key found for provider "anthropic"`).
- After copying `~/.openclaw/agents/main/agent/auth-profiles.json` into `/tmp/openclaw-consumer/.openclaw/agents/main/agent/auth-profiles.json`, immediate auth failure cleared.
- Local agent turn still did not complete reliably within expected timeout window in this harness run, so task-matrix execution remains blocked at agent-turn reliability (not browser attach).

## Next actions

1. Keep existing-session precondition on (`DevToolsActivePort` present, Chrome open).
2. Make local agent turns deterministic for isolated runtime (routing + timeout behavior), then execute the full 2x5 matrix.
3. Run Claude-in-Chrome investigation track.
4. Fill final weighted recommendation with task-level timings and reliability.
