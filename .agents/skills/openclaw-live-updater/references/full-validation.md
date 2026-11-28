# Full release validation

## Full Release Validation

Load `$release-openclaw-ci` and `$openclaw-testing`. This is validation only, never release preparation or publication.

1. Treat 12 hours as wall-clock cadence, not per-SHA cadence. Inspect Full Release Validation runs from the last 12 hours and verify effective `release_profile=full`, `rerun_group=all`, and expected child-job shape. Any valid active or successful full/all umbrella in that window satisfies the cadence even if `main` advanced afterward. Never duplicate an active full/all run. The scheduled `Full Release Validation Nightly` (every 3 hours at :07 UTC, `stable` profile, `main-qualification`) is additional stable-profile evidence and never satisfies this full/all cadence; when both target the same SHA, the full sweep still runs and may adopt the nightly's per-child receipts.
2. Only when the cadence is due, confirm no full/all run is active, then snapshot exact current `origin/main` after checking mirror invariants and dispatch the trusted workflow once:

   ```bash
   MAIN_SHA="<exact-main-sha>"
   pnpm ci:full-release \
     -f validation_purpose=main-qualification \
     --sha "$MAIN_SHA" \
     --workflow-sha "$MAIN_SHA" \
     --trusted-workflow-ref main \
     -f provider=openai \
     -f mode=both \
     -f release_profile=full \
     -f rerun_group=all
   ```

3. Let the helper watch the parent to terminal and verify its release evidence. Retain its parent URL and require the recorded target SHA and children to match the dispatch snapshot. Fetch logs only for failed or blocking jobs. Do not cancel unrelated release checks.
4. For a code or harness failure, repair and land from the Codex worktree under [the maintenance procedure](maintenance.md). Then invoke the same helper with a new frozen exact-main tuple and the narrowest supported `rerun_group` that covers the failed child; use `live_suite_filter` for one live/E2E shard. A targeted recovery run does not create a second full/all cadence dispatch.
5. Report exact SHA, parent and child run URLs/IDs, conclusions, repairs and landed PRs, targeted reruns, and any genuine proof gap. Do not write release evidence or publish artifacts unless separately authorized.
