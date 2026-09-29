# Operator-assisted live verification

Run this only in an isolated OCM environment. Do not point a branch build at a
personal Gateway, config, state, secrets store, port, or process supervisor.

## Automated proof

```bash
node scripts/run-vitest.mjs extensions/facetime
(cd extensions/facetime && npm pack --dry-run)
```

This proves owner-handle validation, separate one-shot open/attach approvals,
capture startup and teardown, realtime PCM/barge-in, live-visual sample clocks,
OBS ownership cleanup, and honest detach semantics. It does not prove a remote
iPhone saw or heard anything.

## Live proof

1. Run `facetime.setup`; confirm there are no SIP, Xcode, debugger, injection,
   or reboot actions.
2. Manually select `OpenClaw-Mic` and `OBS Virtual Camera` in FaceTime.
3. Have the configured owner call, or approve `initiate_call` and confirm the
   outbound call in FaceTime.
4. Answer/confirm in FaceTime, then separately approve
   `attach_current_call` with the configured owner handle.
5. Verify status reports one `operator-confirmed-owner` attachment, native
   input proof, output suppression, Realtime active, and video healthy.
6. From the iPhone verify contextual speech, audible reply, lobster animation,
   barge-in, second response recovery, and no duplicate local output.
7. Run `end_call`; verify OpenClaw media, renderer, OBS scene/source, and any
   bridge-owned Virtual Camera lease are removed. Confirm the result says
   `manualHangupRequired: true`, then end the carrier call in FaceTime.

Record external observations separately from internal status. Never infer
remote audibility or caller identity from process/route readiness.
