# OpenClaw for Linux

The Linux companion is a Tauri v2 desktop shell for local and remote OpenClaw Gateways. It discovers nearby Gateways over Bonjour, installs the CLI when local setup needs it, delegates local Gateway service management to `openclaw gateway`, opens the selected Gateway's Control UI, and stays available in the system tray.

On macOS, the Tauri build is named **OpenClaw-Tauri** so it can be installed alongside the native **OpenClaw** app. It retains its separate bundle identity when updated.

Dashboard widgets and browser panels load inside the app. Browser tabs belong to their conversation and support back, forward, reload, stop, snapshots, element inspection, and saving the current page or asset. Opening the same address in a conversation reuses its tab; other conversations keep their own tabs. Popups opened by a browser tab stay in that conversation.

Reading tabs share a private browser session, isolated from the dashboard's native commands and authentication scripts. Closing every reading tab, switching Gateways, or quitting the app ends that private session. Reloading the dashboard retains its tabs. Sign-in links and **Open in browser** continue to use your system browser.

Startup, setup, connection recovery, Manage Gateways, and Quick Chat share the
web UI's typography and light/dark palettes. They follow system appearance changes
while open, preserving connection drafts, credential visibility, and Quick Chat
replies. The connected dashboard retains its own web UI appearance setting.

During remote setup or in Connection Settings, choose token or password under
**Authentication**. **Show credential** reveals only what you entered; changing
authentication types clears that draft and masks the new field. Press Enter or
**Connect to Gateway** to connect. Leave credentials blank in Connection Settings
to reuse saved credentials for the same endpoint.

The tray's **Stop Gateway** and **Restart Gateway** actions request graceful shutdown. Running work can delay completion; **Start Gateway** brings a stopped local Gateway back online.

After a connection drops, the companion keeps reconnecting while the service state is unknown. **Start Gateway** remains available only for a confirmed stopped service.

The companion uses a unified title bar that blends into the dashboard. Drag the
empty header space, a session title, or the thin strip below the top resize edge
to move the window. Double-click those areas to maximize or restore it; buttons
and editable content keep their normal behavior. The window edges still resize.
Linux and Windows builds place minimize, maximize/restore, and close at the top
right. macOS test builds retain native traffic lights at the top left. Closing
the main window keeps the companion in the tray; closing a separate discovered
Gateway window closes that window.
While a page loads, redirects outside the dashboard, or opens a modal dialog,
Linux and Windows keep the system title bar available until the companion's
controls can receive input again.
Dashboards opt into the unified title bar only when their UI supports its layout
and modal handling. Older Gateways keep the system title bar and their existing
dashboard controls; update the Gateway to enable the unified layout.

Published AMD64 AppImages are built on Ubuntu 22.04 and require glibc 2.35 or
newer plus a `libstdc++` that provides `GLIBCXX_3.4.30`. Ubuntu 22.04 and
Debian 12 meet that ABI floor. RHEL 9 and Rocky Linux 9 ship glibc 2.34, so
they cannot run the published AppImage. Extraction does not bypass this
requirement.

See [Desktop compatibility](https://docs.openclaw.ai/platforms/linux#desktop-compatibility)
for package updates, desktop limitations, and native-app distinctions.

## Chrome setup bridge

The selected main dashboard can explicitly inspect, install, or verify Chrome
setup on the computer running the companion, including when the dashboard's
Gateway is remote. Loading the dashboard does not run setup. Chrome retains its
extension installation approval; the companion does not ask for a pairing key.

The dashboard adapter is
`window.webkit.messageHandlers.openclawChromeSetup.postMessage({action})`,
where `action` is `inspect`, `install`, or `verify`. Its Promise resolves directly
to the canonical CLI setup JSON, including pending and blocked results, and
rejects on transport, invalid-action, or CLI execution errors. It shares the
existing native browser document token, origin/path, and generation checks;
reading tabs and other dashboard windows do not receive this bridge.

The adapter invokes only
`openclaw browser extension setup --action ACTION --json --browser-profile chrome --wait-ms 1000`
through the companion's local CLI owner. Callers cannot choose commands, paths,
profiles, or URLs. Platform bootstrap support comes from the CLI result rather
than the app platform: a Windows app build alone does not establish that native
host bootstrap is supported or verified.

## Omarchy

The optional Omarchy 4 bar plugin provides agents, sessions, and quick prompts.
With the matching desktop app running, it uses the app’s Primary Gateway and
keeps a single visible OpenClaw icon. See [Omarchy support](https://docs.openclaw.ai/platforms/omarchy)
for installation, app handoff, shortcuts, and troubleshooting.

## Linux prerequisites

Debian and Ubuntu development packages:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf xdg-utils
```

Install a current stable Rust toolchain with `rustup`.

## Media codecs

The companion uses GStreamer plugins for audio and video playback.
WebM/VP9, Opus, Vorbis, and WAV normally work through `plugins-good`.
H.264/MP4, AAC, and MP3 require the `libav` and/or `plugins-bad` packages.
The `.deb` uses the host's plugins and declares all three packages as
dependencies. The AppImage bundles the GStreamer media framework and the
plugins required for the formats above. For a source build or when rebuilding
either Linux bundle, install the packages and inspection tool explicitly:

```bash
sudo apt update && sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-tools patchelf xdg-utils
```

The packaging script stages only that media capability set before Tauri invokes
linuxdeploy. This prevents optional host plugins from adding unrelated system
libraries to the AppImage dependency closure.

The packaging flow provisions Tauri's five AppImage tools into a clean,
digest-pinned cache. After Tauri builds the AppImage, the finalizer re-verifies
that cache, removes bundled Wayland client libraries from the retained AppDir,
and rebuilds the artifact. WebKitGTK and Mesa then use one compatible host
stack.

## Develop and build

The companion frontend is static HTML, CSS, and JavaScript. Install repository dependencies once
before building:

```bash
pnpm install
cd apps/linux/src-tauri
cargo run
cargo build
```

The app uses `OPENCLAW_DESKTOP_CLI` when set. Otherwise it checks `~/.openclaw/bin/openclaw`, then `openclaw` on `PATH`.

Desktop notifications use each platform's system notification service. macOS 13+ uses Apple's User Notifications framework; Windows uses native system toasts and Linux uses the desktop notification service through `notify-rust`. On macOS, test notifications from a signed `.app` bundle: a direct `cargo run` stays unbundled, so the app disables notifications instead of initializing Apple's framework with no bundle identity.

### Inline browser live regression on Linux

The existing first-run driver also exercises real native WebKit browser views
against a synthetic Gateway. In addition to the driver's AT-SPI, Xvfb, and D-Bus
packages, install `xdotool` for pointer input. With an unbundled development binary:

```bash
xvfb-run -a -s '-screen 0 1280x1024x24' dbus-run-session -- \
  /usr/bin/python3 apps/linux/tests/first_run.py \
  apps/linux/src-tauri/target/debug/openclaw-desktop --inline-browser
```

This scenario checks real pointer input to the dashboard and native child,
element inspection, PNG snapshots, navigation history, and dashboard reload
persistence. It then uses the app's dashboard deep link to replace the dashboard
in the same process and verifies that a new browser tab works, saves the fixture
bytes through the native chooser, and cancels a second save. The driver owns
an isolated temporary HOME, loopback fixture, and read-only fixture CLI; no real
Gateway or account is used. Add `--artifacts-dir DIRECTORY` to retain native
screenshots and JSON results
outside the repository. Screenshot capture also requires ImageMagick.

### Inline browser live regression on Windows

Start an isolated candidate app with a loopback WebView2 debugging endpoint and
load its loopback Gateway dashboard. Once the dashboard is ready, run this from
the repository root using the repository's supported Node version:

```powershell
node apps/linux/scripts/test-inline-browser.mjs --endpoint http://127.0.0.1:9223
```

The script uses the real dashboard bridge and native child WebViews. It serves
synthetic pages on a separate loopback port and checks navigation, SPA history,
conversation ownership and deduplication, popups, shared browser cookies,
presentation scopes, snapshots, element inspection, dashboard reload persistence,
and cleanup. It does not launch the app, change Gateway settings, or contact
external sites. It closes only the tabs and scopes created by its run.

Use `--dashboard-url http://127.0.0.1:PORT/` to select the candidate dashboard when
multiple local dashboards are open. JSON results and PNG snapshots go to a unique
OS temporary directory; `--output DIRECTORY` selects another proof location.
Keep these generated proofs outside the repository.

Add `--hold` to retain the synthetic pages for native screenshots and save-dialog
checks. Create the printed `continue` file or press Ctrl+C to finish cleanup.
Native visibility and download dialogs still need this UI verification; the
automated scope checks verify the child viewport dimensions and retained tabs.
The script exits nonzero on assertion or cleanup failure. `--help` describes all
options without connecting to the app.

### Native title bar regression on Linux

The first-run driver can exercise window movement and controls through real X11
pointer input. Install `openbox`, `wmctrl`, `xdotool`, `x11-utils`, and
ImageMagick alongside the driver's Xvfb, D-Bus, and AT-SPI dependencies, then run:

```bash
xvfb-run -a -s '-screen 0 1440x1000x24' dbus-run-session -- \
  /usr/bin/python3 apps/linux/tests/first_run.py \
  apps/linux/src-tauri/target/debug/openclaw-desktop --window-chrome \
  --artifacts-dir /tmp/openclaw-window-chrome-proof
```

The driver creates an isolated HOME and desktop session. It checks drag geometry,
double-click maximize/restore, caption buttons, corner resizing, and closing to
the tray. Screenshots and observed window geometry remain in the artifact
directory. This X11 proof does not replace testing a Wayland compositor.

### Native Gateway switching regression on Linux

The same isolated driver covers saved connections, window reuse, restart
selection, and failed-connection recovery. Install `gnome-keyring` alongside the
native title bar test dependencies, then run:

```bash
xvfb-run -a -s '-screen 0 1440x1080x24' dbus-run-session -- \
  /usr/bin/python3 apps/linux/tests/first_run.py \
  apps/linux/src-tauri/target/debug/openclaw-desktop --gateway-switch \
  --artifacts-dir /tmp/openclaw-gateway-switch-proof
```

The driver owns its temporary HOME and Secret Service. It verifies that ordinary
window selection leaves the Primary configuration unchanged. The Linux App
workflow runs this scenario and retains its screenshots and results.

Use `--gateway-onboarding` in place of `--gateway-switch` to exercise local
installation with a synthetic installer, leave Model Setup, and verify native
window controls and Gateway actions under a non-root Gateway path. This scenario
uses the same isolated fixtures and also runs in the Linux App workflow.

## First-run setup

The welcome screen explains what OpenClaw can do and asks where your assistant
should live:

- **On this computer** installs the CLI and managed Node runtime when needed,
  then starts the Gateway as a systemd user service. Release builds install the
  stable channel automatically; development builds ask for a release channel
  and preselect Development.
- **On another computer** connects to an existing Gateway without installing or
  starting a local Gateway service. Select a nearby discovered Gateway, enter a
  Gateway URL directly, or choose **SSH tunnel** and enter `user@gateway-host`.
  Expand **Gateway authentication** to provide either the Gateway token or its
  password when the remote host requires one.

Public direct connections must use HTTPS or secure WebSockets. Plain HTTP or
WebSockets are appropriate only for loopback, trusted private networks, or a
Tailnet. If the Gateway configuration specifies a TLS certificate fingerprint,
choose **SSH tunnel**: the embedded browser cannot enforce certificate pins, so
the app safely refuses direct connections instead of exposing your credentials.
Saved remote credentials support literal values and environment- or
file-backed secret references; exec and shared-store references must be
resolved on their owning Gateway host. SSH connections use your existing
OpenSSH configuration and host-key verification; keep the remote Gateway bound
to loopback when possible. See the
[remote access guide](https://docs.openclaw.ai/gateway/remote) for Gateway
authentication and network requirements.

Use **Connection Settings** in the native tray menu to edit a remote connection.
Opening settings reads only the saved address and transport settings; it does not
resolve credentials, and token and password fields stay empty. **Retry** reconnects
to the saved remote Gateway with freshly resolved credentials without rewriting
configuration or installing or starting a local service. Opening the remote
dashboard does not prove Gateway availability or successful authentication; check
the dashboard for HTTP errors, authentication prompts, and Gateway readiness.

### Switching Gateways

Use **Gateways → Manage Gateways…** in the app or tray menu to save a direct URL
or SSH connection. **Add Gateway** and **Edit** open a focused connection form;
**Back to Gateways** returns to the saved list and discards unsaved changes.
Choose token or password under **Authentication** and enter a credential only
when needed. The credential starts masked; use **Show credential** to inspect
what you entered. Switching authentication types clears the entered credential.
For SSH connections, the optional TLS fingerprint is under **Advanced connection
settings**.

Saved credentials stay in this app's system credential store and are never
filled into the editor. Leave the credential field blank to retain the saved
credentials for the same endpoint.

If the credential store is unavailable, the app keeps the dashboard open and
shows one dismissible notice. Saved connections remain intact. Resolve the
reported credential-store problem, then use **Manage Gateways… → Try again** to load
them again.

The dashboard's profile menu switches the current window to a saved Gateway.
Command-click or Control-click opens another window. The native **Gateways** menu
opens or focuses an existing Gateway window without reloading its current page;
**Open … in New Window** creates an independent window. Successful explicit
selection is remembered across app restarts. Removing a selected Gateway returns
the main window to Primary and closes that Gateway's other windows.

If a saved Gateway cannot load, its window returns to the local connection editor
so you can correct the address or credentials. An edited endpoint becomes the
remembered selection only after its dashboard loads successfully.

Selecting a dashboard does not change the **Primary Gateway**, Quick Chat, or the
desktop connection. **Set as Primary** is a separate, confirmed action for saved
token-authenticated connections. Primary reconnects leave independently selected
Gateway windows alone. **Connection Settings** continues to edit the Primary
connection. Saved Tauri connections are separate from the native macOS app's
saved connections and browser sign-in sessions.

After connecting, Model Setup discovers AI access available to the selected
Gateway and shows it as a choice. Discovery never imports or copies an account,
and the companion never selects, tests, installs, or saves a provider until you
click its action. The list includes supported installed providers and official
provider plugins available from OpenClaw's managed plugin catalog. Installing a
official provider plugin continues directly to that provider's authentication
form without a capability approval prompt. Other plugins require capability
review before installation. Successful verification may require a
Gateway restart before the new model becomes available.

The custom endpoint option supports OpenAI- and Anthropic-compatible services.
For a local Gateway, it opens the canonical guided endpoint setup. For a remote
Gateway, run `openclaw onboard --auth-choice custom-api-key` on the Gateway host as directed by the setup
message; custom-provider secrets must be entered on their owning host. The
desktop companion does not copy remote provider secrets to this computer.

On a fresh install, setup also asks whether existing native Claude and Codex
conversations should appear in OpenClaw. This is discovery only, not an import
or copy. The option starts unchecked; declining disables both native session
catalogs. Existing installations keep their current catalog behavior during an
upgrade.

Once you choose AI access, Model Setup follows the provider's normal review and
verification flow. A temporary connection loss resumes the admitted setup
wizard on the same Gateway and account without repeating installation or the last answer.
After a completed activation requests a restart, setup can resume verification
of that same model. If an unfinished wizard is no longer available, setup shows
a recovery message instead of repeating authentication automatically. **Check again**
refreshes the current setup; if a model was saved, you can explicitly verify and use it. Gateway
failures retain their detailed recovery message so setup can identify
authentication, network, service, or restart problems.

For OpenAI, **ChatGPT Login** uses a ChatGPT or Codex subscription, while
**OpenAI API Key** uses API billing. When the Gateway runs on another host and
its browser callback is not reachable, choose **ChatGPT Device Pairing** from
the additional sign-in options.

## Updates

The companion checks the latest GitHub release shortly after launch and from **Check for Updates** in the tray menu. AppImage installs download and verify the signed update in place, then wait for **Restart to update**. Package-managed installs such as `.deb` stay owned by the system package manager and link to the release download page instead of replacing installed files. The macOS and Windows test builds use a separate opt-in desktop-test update channel; macOS self-updates like the AppImage build, while Windows downloads the update first and runs its installer only after **Restart to update**.

While a newer Gateway release waits for its Linux app, the latest release keeps
the previous published Linux updater manifest. Its original version, signature,
and download URL stay intact. Successful Linux publication advances that
manifest without letting an older build replace a newer available update.

The shipped endpoint remains `releases/latest/download/latest.json`, and
package-managed installs still link to the existing release page. The
`linux-stable` publication channel does not change those client defaults.
Changing them requires separate release-owner approval and signed
installed-client migration proof.

## Quick Chat widgets

Quick Chat advertises the Gateway `inline-widgets` capability and renders hosted `show_widget` results in isolated child WebViews. The parent Quick Chat WebView is the only one granted Tauri commands; widget WebViews match no capability and therefore have no IPC access. Quick Chat accepts only assistant-message widget previews under the capability-scoped `/__openclaw__/canvas/documents/` route, blocks navigation away from the original document, uses nonpersistent WebViews, and keeps stable widget instances while switching among multiple previews. Connections that require a custom Gateway TLS leaf pin remain text-only because the platform WebView cannot bind that pin. Like the other native clients, Quick Chat does not expose the Control UI `sendPrompt` bridge.

Retrying an unchanged Quick Chat draft after a connection error reuses its original idempotency key while the Gateway and agent remain unchanged. If the Gateway confirms the turn already completed, Quick Chat attempts to recover the matching reply from bounded session history instead of resending it. Unavailable or incomplete history produces an error; further retries of that unchanged draft on the same configured Gateway only retry recovery. Widget previews can refresh access after reconnecting to the same configured Gateway, but switching Gateways prevents old previews from using the new connection's access, even after switching back to the original URL.

## Installer resource

`tauri.conf.json` bundles the repository's canonical `scripts/install-cli.sh` directly as `install-cli.sh`. The app never keeps a forked copy. Stable, beta, and dev installs select `latest`, `beta`, and a managed Git `main` checkout respectively, always under `~/.openclaw`.

## Icons

The icon sources of truth live next to the PNGs: `icons/icon.svg` (transparent
claw mark, used by the tray) and `icons/icon-tile.svg` (claw mark on the dark
brand tile, used for the app and package icons). Regenerate the committed PNGs
with librsvg:

```bash
cd apps/linux/src-tauri/icons
rsvg-convert -w 32 --keep-aspect-ratio icon.svg -o 32x32.png
magick 32x32.png -background none -gravity center -extent 32x32 PNG32:32x32.png
rsvg-convert -w 128 -h 128 icon-tile.svg -o 128x128.png
rsvg-convert -w 256 -h 256 icon-tile.svg -o 128x128@2x.png
rsvg-convert -w 512 -h 512 icon-tile.svg -o icon.png
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
rsvg-convert -w 36 -h 36 tray-template.svg -o tray-template.png
```

macOS gets its own tray asset, `icons/tray-template.svg`. AppKit template images
are drawn from the alpha channel alone, so a colored or edge-to-edge opaque icon
arrives in the menu bar as a featureless blob; the template source is a
silhouette with the eyes knocked back out of it. Its geometry mirrors the native
macOS app's `CritterIconRenderer` at rest so both clients wear the same face, and
the 36px render is the 2× backing store for the 18pt slot `tray-icon` scales
menu bar images into. Non-Apple platforms keep the full-color `32x32.png`.

## Packaging

Build a `.deb` and AppImage locally (the same command manual CI runs):

```bash
plugins=$(mktemp -d)
cache=$(mktemp -d)
trap 'rm -rf "$plugins" "$cache"' EXIT
export XDG_CACHE_HOME="$cache"
apps/linux/scripts/stage-appimage-gstreamer.sh "$plugins"
apps/linux/scripts/tauri-appimage-tools.sh prepare
apps/linux/scripts/tauri-appimage-tools.sh verify pre-build
export LDAI_RUNTIME_FILE="$(apps/linux/scripts/tauri-appimage-tools.sh runtime-path)"
(
  cd apps/linux/src-tauri
  GSTREAMER_PLUGINS_DIR="$plugins" \
    pnpm dlx @tauri-apps/cli@2.11.4 build --bundles deb,appimage \
      --config '{"bundle":{"createUpdaterArtifacts":false,"useLocalToolsDir":false}}'
)
apps/linux/scripts/finalize-appimage.sh \
  apps/linux/src-tauri/target/release/bundle/appimage
```

Bundles land in `target/release/bundle/{deb,appimage}/`.

The `Linux App` workflow checks affected pull requests with Rust formatting,
`cargo test --locked --all-targets` on Linux and macOS, and the packaged runtime
ABI scanner's unit tests. It also runs the native Linux inline browser smoke
under Xvfb, including pointer input, snapshots, dashboard replacement, and native
save/cancel, and uploads the synthetic screenshots and JSON results as the
`linux-inline-browser` proof artifact. Bundles, the full graphical first-run
scenarios, and AppImage runtime checks remain manual dispatch checks.

Manually dispatch `Linux App` on the branch to validate packaging before a
release. It retains all pull-request checks, builds the `.deb` and AppImage,
runs both native first-run cases and the packaged AppImage runtime smoke, and
uploads the bundles as the `openclaw-linux-companion` workflow artifact. This
validation does not publish a release.

## Releases

Regular stable publication automatically requests Linux bundles after the
GitHub release becomes visible. `OpenClaw Release Publish` and `OpenClaw Release
Button` both use the same Linux release owner; the request can finish before
the build, signing, and publication do. Their summaries report Linux as pending
until its own assets verify. Beta and alpha prereleases, and extended-stable
publication, do not request Linux bundles.

For independent recovery, manually dispatch `Linux App Release Request` from `main`. Provide the existing
stable release tag in `tag`; prerelease tags are rejected because their semver
suffix breaks Debian upgrade ordering. Enable the optional
`desktop-test-bundles` input only when unsigned macOS and Windows test bundles
are needed.

A successful request automatically triggers `Linux App Release`. It builds from
the validated release tag SHA and attaches the bundles to that tag's GitHub
release with a `SHA256SUMS.linux-app.txt` checksum file. The tag commit must be
reachable from `main` or its matching `release/YYYY.M.PATCH` branch; numeric
correction tags use the base version's release branch.

Linux release requests run one at a time. Default Linux-only retries verify and
reuse an existing complete AppImage, Debian package, signed updater manifest,
and checksum set. Partial or mismatched existing assets require targeted
publication recovery; the workflow does not rebuild or overwrite them. An
optional desktop-test run also refuses to replace published Linux bytes, so
recover missing desktop assets separately when Linux has already published.

The publication helper records an immutable `OpenClaw-<version>-linux.json`
beside the bundles, then advances the fixed `linux-stable` channel and mirrors
it to the latest Gateway release. Reusing complete public bundles still runs
unfinished channel publication; it does not rebuild or replace those bundles.
The control release is prerelease/non-latest and requires explicit
initialization by an authorized Linux publication, never by ordinary PR validation.

Core finalization remains independent of Linux readiness. After finalization,
a detached mirror-only request catches up the legacy endpoint. A dispatch is
not a successful mirror: cancellation, queue overflow, timeout, or readback
failure leaves a visible degraded result for reconciliation. See the
[Linux publication contract](https://docs.openclaw.ai/reference/RELEASING#linux-companion-publication).

The website selects desktop assets at build time. After publication, rebuild
`openclaw.ai` through its existing deployment owner and verify the deployed Apps
card's Linux version and both download links.
