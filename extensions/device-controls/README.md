# Device Controls (private Lobby prototype)

Optional plugin; disabled by default. No imports start playback, install software,
change permissions, select a computer, or modify the daily Gateway.

Enable the plugin explicitly on the laboratory Gateway and intended macOS Node
host. Explicitly allow `device-controls.audio` in the existing Gateway node-command
policy. Node host availability advertises `device.audio` only on macOS with Apple's
`/usr/bin/afplay`. The Mac app embeds a Node-host worker, but the connected node
must actually advertise the enabled plugin command. For the laboratory, use a
separate supported Node host with `--commands device-controls.audio` to keep its
advertisement narrow; do not assume an installed Mac app exposes this command.

## Widget bindings

All calls use named, user-approved action bindings and a trusted user gesture.
The bindings freeze the target; runtime arguments cannot override fixed values.

| Verb / RPC                   | Required fixed parameters                                                                      | Dynamic parameters                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `device-controls.audio`      | `nodeId`, `operationId` (UUID)                                                                 | `notes`, optional `volume`                                          |
| `device-controls.audio-stop` | same `nodeId`, `operationId`                                                                   | none                                                                |
| `device-controls.pointer`    | `nodeId`, `operation` (`move` or `scroll`), `screenIndex`, `referenceWidth`, `referenceHeight` | move: `x`, `y`; scroll: `x`, `y`, `scrollDirection`, `scrollAmount` |

An operation UUID is an explicitly granted control target, not a secret or a claim
of per-widget isolation. Two widgets granted the same UUID can stop that operation.
Use a distinct UUID for each independently controlled source and the same UUID in
its play/stop bindings. The node rejects another active UUID's stop command.

Audio accepts 1–32 sinusoidal notes, 20–8000 Hz, 20–2000 ms per note, at most ten
seconds total, amplitude 0–0.25 (default 0.1). It synthesizes 24 kHz mono PCM with
faded boundaries. No external files, URLs, shell, arbitrary commands or device
selection are accepted. One playback runs at a time; there is no playback queue
or automatic retry after an uncertain result. Audio output still depends on the
computer's selected output and volume; generated PCM is not proof of audibility.

Playback awaits the fixed native child and owns a private temporary WAV, removed
after exit. Caller cancellation, node disconnect and the twelve-second execution
deadline terminate that child (TERM, then KILL after 500 ms). The node remains busy
through cleanup. Revocation prevents further dispatch; there is no claim that a
grant change instantly silences an already-started invocation. Use Stop or rely
on the bounded lifetime. No microphone permission is requested.

Pointer actions reuse the existing `computer.act` owner and its configured node
policy and macOS accessibility/input permission. This plugin neither installs a
computer-control driver nor grants OS permissions. Only move/scroll are admitted;
no clicks, held buttons, keys, text, process or browser actions. Each operation uses
a new execution UUID and attempts to close exactly it after transport failure.
The first snapshot opts into a 15-second absolute native execution deadline.
Input requires that same execution to still exist; delayed input cannot recreate
an unbounded resource after expiry. The provider registration aborts in-flight work and closes the admitted execution
when that deadline expires, even if lost caller authority prevents the close RPC.
Physical cleanup must settle before the provider admits another execution; a
cleanup failure stays busy and visible. Callers without an explicit deadline
retain the existing provider lifecycle. The macOS app applies the same options
to its outer desktop reservation. Its existing two-second monitor initiates expiry
cleanup on the next observation; admission and effect checks also reject expired
permits. This is not a promise that physical cleanup finishes exactly at the deadline.
One request is in flight at a time, at least 50 ms between dispatches; callers must coalesce
continuous input instead of replaying queued movement. Both `computer.act` and `screen.snapshot` must be explicitly allowed. Each action
observes the selected screen inside its own execution before sending input. Its
captured pixels stay inside that invocation and are not returned to the component.
The user grant must describe screen observation as well as pointer control.

The fixed reference width and height describe the captured coordinate plane.
Capture uses their larger dimension as its longest-side limit, without enlargement;
the returned width, height and display index must match exactly. A mismatch refuses
input and requires a new binding. This supports landscape and portrait without
silently remapping coordinates. Both movement and scrolling require an explicit
point inside that frame; scrolling never inherits an unrelated cursor position. The freshly issued frame is passed only within
its native execution; CUA rejects frames from other executions. Native display
identity limitations still apply (for example CUA identifies only the primary
display); equal-sized display replacement is not independently detected here.

## Validation

`manifest.test.ts` loads the shipped manifest through the control-plane manifest
registry, checking activation metadata and the required fixed bindings. This
catches packaging/configuration rejection before any device action is attempted.

`src/audio.test.ts` exercises the actual PCM renderer, parser, playback owner and
fixed player process lifecycle using a synthetic child; it never plays audio.
`src/gateway.test.ts` exercises target checks, authority expiry, typed dispatch,
bounded input and execution cleanup through a synthetic nodes transport. These
tests do not claim physical pointer or audio qualification. Real hardware effects
must be separately scoped to an isolated laboratory setup.
