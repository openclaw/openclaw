---
summary: "Windows support: Windows Hub, native CLI and Gateway, WSL2 gateway setup, node mode, and troubleshooting"
read_when:
  - Installing OpenClaw on Windows
  - Choosing between Windows Hub, native Windows, and WSL2
  - Setting up the Windows companion app or Windows node mode
title: "Windows"
---

OpenClaw ships a native **Windows Hub** companion app plus Windows CLI support.
Use Windows Hub for a desktop app with setup, tray status, chat, Command
Center diagnostics, and Windows node capabilities. Use the PowerShell
installer for the CLI/Gateway directly. Use WSL2 for the most
Linux-compatible Gateway runtime.

## Recommended: Windows Hub

Windows Hub is the native WinUI companion app for Windows 10 20H2+ and
Windows 11. It installs without administrator privileges and ships signed x64
and ARM64 installers from its own release page.

Windows Hub publishes independently from the OpenClaw CLI and Gateway. Download
the latest stable Hub installer from the
[Windows Hub releases page](https://github.com/openclaw/openclaw-windows-node/releases/latest)
or directly via `releases/latest/download`:

- [OpenClawCompanion-Setup-x64.exe](https://github.com/openclaw/openclaw-windows-node/releases/latest/download/OpenClawCompanion-Setup-x64.exe)
- [OpenClawCompanion-Setup-arm64.exe](https://github.com/openclaw/openclaw-windows-node/releases/latest/download/OpenClawCompanion-Setup-arm64.exe)

If a link above 404s, visit the [Windows Hub releases page](https://github.com/openclaw/openclaw-windows-node/releases)
and open the newest stable Windows Hub release. Regular OpenClaw stable releases
also mirror a pinned, release-validated Windows Hub build; that mirror can lag a
newer standalone Hub release.

After install, launch **OpenClaw Companion** from the Start menu or system
tray. The installer also adds shortcuts for Gateway Setup, Chat, Settings,
Check for Updates, and uninstall.

### What Windows Hub includes

- System tray status and launch-at-login.
- First-run setup for a local app-owned WSL Gateway.
- Connection settings for local, remote, and SSH-tunneled Gateways.
- Native chat window plus access to the browser Control UI.
- Command Center diagnostics for sessions, usage, channels, nodes, pairing,
  and repair commands.
- Windows node mode for screen, camera, notifications, device status, talk,
  and controlled `system.run`.
- Local MCP server mode for MCP clients such as Claude Desktop, Claude Code,
  and Cursor.

### First launch

On first launch, Windows Hub opens setup when there is no usable saved
Gateway. The fastest path is **Set up locally**, which provisions an
app-owned `OpenClawGateway` WSL distro, installs the Gateway inside it, and
pairs the app. This does not export or mutate your existing Ubuntu distro.

Choose **Advanced setup** or open the Connections tab when you already have a
Gateway. You can connect to:

- a local Gateway on this PC
- a WSL Gateway on this PC
- a remote Gateway by URL and token or setup code
- a Gateway reached through an SSH tunnel

When setup finishes, the tray icon turns green. Open **Command Center** from
the tray to confirm connection, pairing, node status, and channel health.

## Windows node mode

Windows Hub can register as an OpenClaw node so the agent can use declared
Windows-native capabilities through the Gateway. Node commands must be
declared by the node, included in its approved surface, and allowed by Gateway
policy before they run; see
[Nodes](/nodes/command-policy#command-policy) for the full allow/deny model.

Common commands:

| Family | Commands                                                                            |
| ------ | ----------------------------------------------------------------------------------- |
| Screen | `screen.snapshot`; `screen.record` requires explicit opt-in                         |
| Camera | `camera.list`; `camera.snap`, `camera.clip` require explicit opt-in                 |
| System | `system.notify`, `system.run`, `system.run.prepare`, `system.which`                 |
| Device | `location.get`, `device.info`, `device.status`                                      |
| Talk   | `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, `talk.ptt.once`, `talk.speak` |

Node mode requires Gateway pairing. If the app shows a pairing request,
approve it from the Gateway host:

```powershell
openclaw devices list
openclaw devices approve <deviceRequestId>
```

Device approval admits the connection only. If node mode has paused for manual
pairing, restart node mode or the app so it reconnects. This reconnect creates
a separate command-surface request. On the Gateway:

```powershell
openclaw nodes pending
openclaw nodes approve <nodeRequestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

The two request IDs are distinct. An initial unapproved surface has no effective
commands. During a pending expansion, approved commands that remain declared and
allowed can still run. SSH-verified and bootstrap enrollment can approve the
first surface automatically; trusted-network device approval alone does not.
Later command, capability, or permission expansion still requires approval.

The Gateway only forwards commands the node declares and server policy
allows. Privacy-sensitive commands such as `screen.record`, `camera.snap`,
and `camera.clip` need explicit `gateway.nodes.commands.allow` opt-in.

## Local MCP mode

Windows Hub can expose the same Windows-native capability registry as a local
MCP server on loopback, so local MCP clients can drive Windows capabilities
without a running OpenClaw Gateway.

Enable it in Windows Hub Settings under the developer/advanced section. The
app shows the loopback endpoint and bearer token once the server is enabled.

Mode matrix:

| Node mode | MCP server | Behavior                           |
| --------- | ---------- | ---------------------------------- |
| off       | off        | Operator-only desktop app          |
| on        | off        | Gateway-connected Windows node     |
| off       | on         | Local MCP server only              |
| on        | on         | Gateway node plus local MCP server |

## Native Windows CLI and Gateway

For terminal-first use, install OpenClaw from PowerShell:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Verify:

```powershell
openclaw --version
openclaw doctor
openclaw gateway status --json
```

Managed startup uses Windows Scheduled Tasks when available. The task keeps
the readable `gateway.cmd` script in the OpenClaw state dir but launches it
through a generated `gateway.vbs` WScript wrapper, so the background Gateway
does not open a visible console window. If task creation is denied, OpenClaw
falls back to a per-user Startup-folder login item.

If you append output redirection to the `gateway.cmd` launch line, quote the
entire target, for example `>> "%USERPROFILE%\.openclaw\logs\gateway-stdout.log" 2>&1`.
Complete trailing redirections are excluded from process ownership checks.
Unquoted environment expansions can leave filename fragments in the Gateway's
arguments; OpenClaw preserves ambiguous launcher commands and refuses to terminate
a listener whose ownership cannot be verified. Quote the target before retrying.

The hidden launcher owns the supervised Gateway process tree. Ending the task
with `schtasks /end /tn "OpenClaw Gateway"`, `Stop-ScheduledTask`, or Task
Scheduler's **End** action terminates the Gateway and its descendants. After
updating an older installation, run `openclaw gateway install --force` to
regenerate the launcher if the update did not refresh it.

Gateway status and Doctor read the Scheduled Task's numeric current state, independently of the Windows display language or console code page. A previous task exit result does not prove whether it is running now. Queued or unknown tasks do not count as safely stopped for Doctor maintenance. Stop a queued task through its service owner; if inspection is inaccessible, restore Task Scheduler inspection permissions before retrying.

Strict maintenance inspection follows the task's registered CMD or VBS launcher, or a directly registered executable with literal arguments, and rechecks its captured definition before using the result. Runtime inspection uses that registered command rather than a default launcher. Direct executable inspection does not grant ownership to rewrite the executable or its task definition. Automatic update service management still reports these custom actions as unavailable and leaves them untouched because it cannot restore a managed launcher; environment expansion and ambiguous argument quoting remain uninspectable. Deep discovery identifies OpenClaw and legacy helpers from executable or launcher evidence; an unrelated task's display name alone does not identify a service. Canonical and selected task names suppress extra-service findings only when the registered action is a modern Gateway; legacy and Node actions remain visible. Doctor reports incomplete inspection separately from services eligible for existing cleanup.

Doctor and deep status provide read-only `schtasks /Query` hints for extra Scheduled Tasks, including Node hosts. Discovery shares one 60-second budget across the inventory query and launcher inspection. If it expires, completed discoveries remain available and Doctor reports that some services could not be inspected. Review the registered command and purpose before choosing removal through the service's owner.

Doctor compares task definitions using Task Scheduler's defaults. An omitted
`Enabled` element means `true` for both the task and its logon trigger, so XML
export differences do not cause drift warnings or failed refresh verification.
Explicitly disabled tasks and triggers are still reported.

The task probe allows Windows PowerShell to inherit or create a console because
some PowerShell 5.1 hosts fail inspection when console creation is disabled.
Invoking it from an app without a console can briefly display a console window.
Without an explicit caller deadline, each probe allows up to 60 seconds for
PowerShell's cold startup. Registration inspection uses the same native probe
and shares its budget with any Startup-folder checks. Explicit inspection
budgets replace the default allowance. Direct lifecycle commands retain their
existing limits. Access-denied and timeout results remain inspection failures,
not proof that a task is absent.
If inspection fails, Doctor and update refusals include the underlying probe
detail; an empty response identifies the exit code and reports that PowerShell
produced no output.

During previous-Gateway readiness verification, each Scheduled Task runtime probe allows at most five seconds, or the shorter remaining budget. Other service inspections retain their caller's budget, including the longer allowance for verifying that a runtime rebuild is safe.

During update preflight, Scheduled Task inspection uses the update's `--timeout` budget. A registration or runtime timeout retries the complete strict inspection once. If inspection remains unavailable, the update reports the enforced budget and probe detail, preserves the recorded service definition, and skips automatic service restart. Inspect the service with `openclaw gateway status --deep`, then restart it manually after the update. Losing verified ownership after admission blocks the service mutation.

Gateway startup creates private SQLite staging directories through Windows APIs,
without compiling C# or launching PowerShell for their permissions. The owner,
SYSTEM, and Administrators retain full access; other inherited access is removed
at creation. Update restart helpers also avoid runtime C# compilation and
`Invoke-Expression`. If antivirus software still interrupts a start, include its
detection name and the output of `openclaw gateway status --json` in your report.

Install the Gateway service:

```powershell
openclaw gateway install
openclaw gateway status --json
```

For CLI-only use without a managed Gateway service:

```powershell
openclaw onboard --non-interactive --accept-risk --skip-health
openclaw gateway run
```

## WSL2 Gateway

WSL2 remains the most Linux-compatible Gateway runtime on Windows. Windows
Hub can set up an app-owned WSL Gateway for you, or install manually inside
your own distro.

Manual setup:

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Enable systemd inside WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Restart WSL from PowerShell:

```powershell
wsl --shutdown
```

Then install OpenClaw inside WSL with the Linux quickstart:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw gateway status
```

## Gateway auto-start before Windows login

For headless WSL setups, make sure the full boot chain runs even when no one
logs into Windows.

Inside WSL:

```bash
sudo apt-get install -y dbus-x11
sudo loginctl enable-linger "$(whoami)"
openclaw gateway install
```

In PowerShell as Administrator:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec dbus-launch true" /sc onstart /ru "$env:USERNAME"
```

Replace `Ubuntu` with your distro name from:

```powershell
wsl --list --verbose
```

<Note>
Two changes from older recipes:

- **`dbus-launch true` instead of `/bin/true`**: on WSL >= 2.6.1.0 a
  regression ([microsoft/WSL #13416](https://github.com/microsoft/WSL/issues/13416))
  idle-terminates the distro 15-20 seconds after the last client exits, even
  with linger enabled. `dbus-launch true` keeps a child-of-init process alive
  as a workaround (community discussion, [microsoft/WSL #9245](https://github.com/microsoft/WSL/discussions/9245)).
- **`/ru "$env:USERNAME"` instead of `/ru SYSTEM`**: per-user WSL distros (the
  default setup) are not visible to the SYSTEM account, so the task appears
  to run but the distro never starts. Running as your own account avoids
  this; Windows prompts for your password when the task is created.

</Note>

After reboot, verify from WSL:

```bash
systemctl --user is-enabled openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager
```

## Expose WSL services over LAN

WSL has its own virtual network. If another machine must reach a service
inside WSL, forward a Windows port to the current WSL IP. The WSL IP can
change after restarts, so refresh the forwarding rule when needed.

Example in PowerShell as Administrator:

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort

New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Notes:

- SSH from another machine targets the Windows host IP, e.g. `ssh user@windows-host -p 2222`.
- Remote nodes must point at a reachable Gateway URL, not `127.0.0.1`.
- Use `listenaddress=0.0.0.0` for LAN access, `127.0.0.1` for local-only access.

## Troubleshooting

### The Scheduled Task stops before the Gateway is ready

Run `openclaw gateway status --json`, then inspect the local [Gateway log](/gateway/logging).
Entries from `gateway/task-supervisor` record the child exit code, signal, and
the last 8,192 characters of stderr, including failures before Gateway logging
starts. Child stdout is discarded. A failed child or supervisor exits nonzero;
an intentional clean stop still exits zero. A successful task result alone does
not prove the Gateway is healthy.

Task Scheduler's [`RestartOnFailure` policy](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/2ff4aa5a-7bc4-449f-bbb1-27475645867f)
retries failed start conditions or action launches. Do not rely on it to restart
a Gateway that launches successfully and then exits with an error, such as an
occupied port. Fix the logged cause, then run `openclaw gateway start`.

### The tray icon does not appear

Check Task Manager for `OpenClaw.Tray.WinUI.exe`. If it is running, open the
hidden tray-icons area and pin it. If not, launch **OpenClaw Companion** from
the Start menu.

### Local setup fails

Open the setup log from Windows Hub or inspect:

```powershell
notepad "$env:LOCALAPPDATA\OpenClawTray\Logs\Setup\easy-setup-latest.txt"
```

Common causes: disabled WSL, blocked virtualization, stale app-owned WSL
state, or a network failure while installing the Gateway package.

### The app says pairing is required

Approve the operator or node request from the Gateway:

```powershell
openclaw devices list
openclaw devices approve <requestId>
```

If the device already had a token, reconnect from the Connections tab after
approval.

For a node request, complete the separate command-surface approval in
[Windows node mode](#windows-node-mode): restart paused node mode, then run
`openclaw nodes pending` and approve its distinct node request ID. Operator-device
approval alone does not complete that node flow.

### Web chat cannot reach a remote Gateway

Remote web chat needs HTTPS or localhost. For self-signed certificates, trust
the certificate in Windows, or use an SSH tunnel to a localhost URL.

### `screen.snapshot`, camera, or audio commands fail

Confirm Windows permissions for camera, microphone, screen capture, and
notifications. Packaged installs declare the protected capabilities, but
Windows may still prompt the first time a command uses them.

### Git or GitHub connectivity fails

Some networks block or throttle HTTPS to GitHub. If `git clone` or
`gh auth login` fails, try another network, a VPN, or an HTTP/HTTPS proxy.

For token-based `gh` auth in the current session:

```powershell
$env:GH_TOKEN="<your-token>"
gh auth status
gh auth setup-git
```

Never commit tokens or paste them into issues or pull requests.

## Related

- [Install overview](/install)
- [Node.js setup](/install/node)
- [Nodes](/nodes)
- [Control UI](/web/control-ui)
- [Gateway configuration](/gateway/configuration)
