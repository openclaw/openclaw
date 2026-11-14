# iOS proof recipes

End-to-end proof beyond a chat round trip, for the [iOS E2E loop](SKILL.md); `$sim`, `$bundle` and `oc` (with `--profile <profile>`) are defined there. Run anything that breaks auth or state against a throwaway profile with its own state directory and port (for example `ios-rl` on 19041), never `ios-sim`; delete it afterwards with `trash ~/.openclaw-<profile>`.

## Node commands

- Call a command directly: `oc nodes invoke --node <id> --command <command> --params '<json>' --json`. `oc nodes status` shows each node's declared commands and permissions; a widened permission stays pending until `oc nodes approve`.
- Opt-in commands (`calendar.add`, `reminders.add`, `camera.snap`, `health.summary`) are refused until `gateway.nodes.commands.allow` lists them. Copy `~/.openclaw-<profile>/openclaw.json` aside, set the allowlist (the Gateway hot-reloads it), prove, then restore the copy and confirm with `diff`.

## Permissions

- Grant, revoke or reset without the UI: `xcrun simctl privacy "$sim" grant|revoke|reset <service> "$bundle"`. Revoking terminates the app.
- Prove a first-use prompt through the feature that raises it (dictation, `camera.snap`) and through Settings → Device Settings → Permissions.

## Auth failures and lockouts

1. Password auth on the throwaway profile: `oc config set gateway.auth.mode password`, `oc config set gateway.auth.password <test-password>`, `oc config set gateway.auth.rateLimit.exemptLoopback false --strict-json` (loopback is otherwise exempt from the limiter).
2. Pair with `pnpm ios:sim:pair --profile <profile>`.
3. Make reconnects fail:
   - Revoke the device's tokens: `oc devices list --json` for the device id, then `oc devices revoke --device <id> --role operator` and `--role node`. Every reconnect is then rejected.
   - Lock out the address: run `oc gateway call health --password wrong-$i --timeout 3000` 11 times. The default limiter allows 10 failures per minute and locks for 5 minutes. While locked, `config set` also fails; edit `openclaw.json` instead.
4. Count the app's rejected handshakes by role and reason from the Gateway log's `closed before connect` lines (`role=`, `authProvided=`, `authReason=`), excluding `client=cli`.
5. Restart the Gateway before the next build's run so the limiter starts clean.

## Gateway outage

- Freeze the Gateway without closing sockets: `kill -STOP <pid>` (pid from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`), wait past the 60 s tick tolerance, then `kill -CONT <pid>`. The app shows Connecting, then a timeout, and should reconnect on its own after `CONT`.
- Stopping the Gateway queues chat sends offline; starting it again delivers them.

## Rejected sends

Archive the target session while the app is closed: `oc sessions archive <session-key>`. Every `chat.send` to it is then rejected with `INVALID_REQUEST`, while `chat.history` still answers. Restore it afterwards with `oc gateway call sessions.patch --params '{"key":"<key>","archived":false,"expectedSessionId":"<id>"}'`; `oc gateway call sessions.list --params '{"archived":true}'` lists the id.

## Upgrade from the latest stable release

Required when a change touches stored data, migrations or settings (root `AGENTS.md`: upgrade from the latest stable).

1. Build the latest stable tag in its own worktree with its own DerivedData.
2. On a fresh simulator, install the stable app, pair it, and create the state the change reads (queued messages, drafts, settings).
3. Install the change's app over it with `simctl install` (the data container is kept), relaunch, and show the state still loads and works. SQLite state is in `$(xcrun simctl get_app_container "$sim" "$bundle" data)/Library/Application Support/OpenClaw/databases/`.

## Layout

- Sidebar screenshots: use an iPad Pro 13", where the sidebar is persistent. Taps on the iPad's persistent sidebar do not register through UI automation; open each destination with `--openclaw-initial-destination`.
- UI tests in the `OpenClawUITests` scheme run with `pnpm ios:test OpenClawUITests/<Suite>/<test>`; `IOS_SIM` picks an iPad.

## Physical iPhone only

The simulator cannot prove these:

- Voice Wake: disabled on the simulator.
- Motion: the simulator node declares no `motion.*` commands.
- Camera capture: `camera.snap` returns `Camera unavailable` even after a grant.
- Quick Setup Connect: it requires a TLS Gateway, and the Bonjour TLS flag never reaches the simulator.
- Hitch, SwiftUI-instrument and energy measurements.
