import type { WorkerDesktopEndpoint } from "openclaw/plugin-sdk/plugin-entry";
import { assertCrabboxLeaseId } from "./crabbox-worker-profile.js";

export const CRABBOX_MACOS_APP_PATH = "/Applications/OpenClawCloudWorker.app";
const CRABBOX_MACOS_HOST_VERSION = 1;
const MACOS_DESKTOP_ROOT = "/var/db/crabbox/openclaw-workers";
const MACOS_CDP_PORT = 9222;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function crabboxMacosDesktopDirectory(leaseId: string): string {
  assertCrabboxLeaseId(leaseId);
  return `${MACOS_DESKTOP_ROOT}/${leaseId}`;
}

function desktopRoot(leaseId: string, sshUser: string): string {
  if (typeof sshUser !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/u.test(sshUser)) {
    throw new Error("Crabbox macOS desktop requires its inspected SSH account username");
  }
  return crabboxMacosDesktopDirectory(leaseId);
}

function requireGuiAccount(sshUser: string): string {
  return `worker_user=$(/usr/bin/id -un)
worker_uid=$(/usr/bin/id -u)
[ "$worker_user" = ${quote(sshUser)} ] && [ "$worker_uid" -ne 0 ] || { echo 'Cloud desktop must run as its inspected macOS account' >&2; exit 1; }
[ "$(/usr/bin/stat -f '%u' /dev/console)" = "$worker_uid" ] || { echo 'Sign in to the worker macOS account before dispatching a desktop session' >&2; exit 1; }
/bin/launchctl print "gui/$worker_uid" >/dev/null 2>&1 || { echo 'The worker macOS GUI session is unavailable; sign in before dispatch' >&2; exit 1; }`;
}

/** SSH needs root to adopt another audit session; GUI commands still run as the lease account. */
export function createCrabboxMacosGuiLaunchScript(): string {
  return `set -euo pipefail
worker_uid=$(/usr/bin/id -u)
worker_user=$(/usr/bin/id -un)
[ "$worker_uid" -ne 0 ] && [ "$(/usr/bin/stat -f '%u' /dev/console)" = "$worker_uid" ] || { echo 'The worker account no longer owns the macOS desktop' >&2; exit 1; }
worker_home=$(/usr/bin/dscl . -read "/Users/$worker_user" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')
worker_tmp=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)
case "$worker_home:$worker_tmp" in /*:/*) ;; *) echo 'The worker account home or temporary directory is unavailable' >&2; exit 1 ;; esac
exec /usr/bin/sudo -n -- /bin/launchctl asuser "$worker_uid" /usr/bin/sudo -n -u "#$worker_uid" -- /usr/bin/env -i HOME="$worker_home" USER="$worker_user" LOGNAME="$worker_user" PATH="$PATH" TMPDIR="$worker_tmp" LC_ALL=C /bin/sh -c 'cd -- "$1"; shift; exec "$@"' openclaw-gui "$PWD" "$@"`;
}

function browserLauncher(root: string, sshUser: string): string {
  return `#!/bin/bash
set -euo pipefail
[ "$#" -eq 0 ] || { echo 'Cloud browser launcher does not accept arguments' >&2; exit 64; }
${requireGuiAccount(sshUser)}
exec /bin/bash -c ${quote(createCrabboxMacosGuiLaunchScript())} openclaw-gui /usr/bin/lockf -k -t 25 ${quote(`${root}/browser-profile/.launch.lock`)} /bin/bash <<'CRABBOX_BROWSER_LOCKED'
set -euo pipefail
profile=${quote(`${root}/browser-profile`)}
browser='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
[ -x "$browser" ] || { echo 'Install Google Chrome in the macOS worker image' >&2; exit 1; }
cdp_url=http://127.0.0.1:${MACOS_CDP_PORT}/json/version
owned_browser() {
  [ -f "$profile/browser.pid" ] || return 1
  browser_pid=$(cat "$profile/browser.pid")
  case "$browser_pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(/bin/ps -p "$browser_pid" -o uid= | tr -d ' ')" = "$(/usr/bin/id -u)" ] || return 1
  browser_command=$(/bin/ps -ww -p "$browser_pid" -o command=) || return 1
  case "$browser_command" in "$browser "*) ;; *) return 1 ;; esac
  case "$browser_command" in *"--user-data-dir=$profile "*) ;; *) return 1 ;; esac
}
cdp_ready() { /usr/bin/curl --fail --silent --max-time 1 "$cdp_url" >/dev/null; }
owned_cdp() {
  owned_browser || return 1
  /usr/sbin/lsof -nP -a -p "$browser_pid" -iTCP:${MACOS_CDP_PORT} -sTCP:LISTEN -Fn | grep -Fx 'n127.0.0.1:${MACOS_CDP_PORT}' >/dev/null
}
if cdp_ready; then
  owned_cdp || { echo 'CDP port belongs to another browser; reprovision the desktop worker' >&2; exit 1; }
  exit 0
fi
if ! owned_browser; then
  /usr/bin/nohup "$browser" "--user-data-dir=$profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=${MACOS_CDP_PORT} --no-first-run --no-default-browser-check about:blank >>"$profile/launch.log" 2>&1 </dev/null &
  printf '%s\\n' "$!" >"$profile/browser.pid"
fi
for ((attempt=0; attempt<40; attempt++)); do
  if cdp_ready; then owned_cdp && exit 0; fi
  sleep 0.5
done
echo 'Cloud browser CDP did not become ready within 20 seconds' >&2
exit 1
CRABBOX_BROWSER_LOCKED`;
}

function terminalLauncher(sshUser: string): string {
  return `#!/bin/bash
set -euo pipefail
[ "$#" -eq 0 ] || { echo 'Cloud terminal launcher does not accept arguments' >&2; exit 64; }
${requireGuiAccount(sshUser)}
exec /bin/bash -c ${quote(createCrabboxMacosGuiLaunchScript())} openclaw-gui /usr/bin/open -a /System/Applications/Utilities/Terminal.app`;
}

export function createCrabboxMacosDesktopSetup(
  leaseId: string,
  wallpaperBase64: string,
  sshUser: string,
): string {
  const root = desktopRoot(leaseId, sshUser);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(wallpaperBase64)) {
    throw new Error("Crabbox macOS desktop wallpaper must be base64");
  }
  return `set +x
set -euo pipefail
umask 077
${requireGuiAccount(sshUser)}
app=${quote(CRABBOX_MACOS_APP_PATH)}
plist="$app/Contents/Info.plist"
[ -x "$app/Contents/MacOS/OpenClaw" ] && [ -x "$app/Contents/Resources/cua-driver" ] || { echo 'Install the signed OpenClaw Cloud Worker app with its bundled CUA driver in the worker image' >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$app" || { echo 'The macOS worker app signature is invalid; replace the image app' >&2; exit 1; }
signature=$(/usr/bin/codesign -dv --verbose=4 "$app" 2>&1)
grep -q '^Authority=Developer ID Application:' <<<"$signature" || { echo 'The macOS worker app needs a Developer ID Application signature' >&2; exit 1; }
grep -Eq '^TeamIdentifier=[A-Z0-9]{10}$' <<<"$signature" || { echo 'The macOS worker app signing team is missing' >&2; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")" = OpenClaw ] || { echo 'The worker app executable identity is invalid' >&2; exit 1; }
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
[ "$bundle_id" = ai.openclaw.cloud-worker ] || { echo 'The desktop requires the separate OpenClaw Cloud Worker app identity' >&2; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawCloudWorkerHostVersion' "$plist")" = ${CRABBOX_MACOS_HOST_VERSION} ] || { echo 'Update the signed OpenClaw Cloud Worker app in the worker image for cloud desktop support' >&2; exit 1; }
worker_group=$(/usr/bin/id -gn)
worker_root=${quote(root)}
sudo -n -- /usr/bin/install -d -o root -g wheel -m 0755 ${quote(MACOS_DESKTOP_ROOT)}
sudo -n -- /usr/bin/install -d -o "$worker_user" -g "$worker_group" -m 0700 "$worker_root"
[ ! -L "$worker_root" ] && [ "$(/usr/bin/stat -f '%u' "$worker_root")" = "$worker_uid" ] || { echo 'The cloud desktop directory is not owned by its worker account' >&2; exit 1; }
setup_dir=$(mktemp -d "$worker_root/.setup.XXXXXX")
trap 'rm -rf -- "$setup_dir"' EXIT
sudo -n -- /bin/cat /var/db/crabbox/vnc.password >"$setup_dir/vnc.password"
[ -s "$setup_dir/vnc.password" ] || { echo 'The managed macOS desktop credential is missing' >&2; exit 1; }
chmod 0600 "$setup_dir/vnc.password"
mv -f "$setup_dir/vnc.password" "$worker_root/vnc.password"
cat >"$setup_dir/browser" <<'CRABBOX_BROWSER_LAUNCHER'
${browserLauncher(root, sshUser)}
CRABBOX_BROWSER_LAUNCHER
cat >"$setup_dir/terminal" <<'CRABBOX_TERMINAL_LAUNCHER'
${terminalLauncher(sshUser)}
CRABBOX_TERMINAL_LAUNCHER
chmod 0700 "$setup_dir/browser" "$setup_dir/terminal"
mv -f "$setup_dir/browser" "$worker_root/browser"
mv -f "$setup_dir/terminal" "$worker_root/terminal"
mkdir -p "$worker_root/browser-profile"
chmod 0700 "$worker_root/browser-profile"
printf '%s' ${quote(wallpaperBase64)} | /usr/bin/base64 -D >"$setup_dir/wallpaper.png"
mv -f "$setup_dir/wallpaper.png" "$worker_root/wallpaper.png"
"$worker_root/browser"`;
}

export function createCrabboxMacosDesktopEndpoint(
  leaseId: string,
  sshUser: string,
): WorkerDesktopEndpoint {
  const root = desktopRoot(leaseId, sshUser);
  return {
    protocol: "rfb",
    port: 5900,
    allowsResize: false,
    username: sshUser,
    passwordFilePath: `${root}/vnc.password`,
    apps: [
      { id: "browser", executablePath: `${root}/browser`, cdpPort: MACOS_CDP_PORT },
      { id: "terminal", executablePath: `${root}/terminal` },
    ],
  };
}
