import type { WorkerDesktopEndpoint } from "openclaw/plugin-sdk/plugin-entry";

const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_DESKTOP_ROOT = String.raw`C:\ProgramData\OpenClaw\cloud-workers`;
const WINDOWS_CDP_PORT = 9222;

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function desktopDirectory(leaseId: string): string {
  return `${WINDOWS_DESKTOP_ROOT}\\${leaseId}\\desktop`;
}

const sessionIdentity = String.raw`
if (-not ('OpenClawActiveSession' -as [type])) {
  Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpenClawActiveSession {
  [StructLayout(LayoutKind.Sequential)] struct Session { public int id; public IntPtr name; public int state; }
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int kind, out IntPtr value, out int bytes);
  static string Read(int session, int kind) {
    IntPtr value; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, kind, out value, out bytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Marshal.PtrToStringUni(value); } finally { WTSFreeMemory(value); }
  }
  public static string UserSid(int session) { return new System.Security.Principal.NTAccount(Read(session, 7), Read(session, 5)).Translate(typeof(System.Security.Principal.SecurityIdentifier)).Value; }
  public static int Get() {
    IntPtr sessions; int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessions, out count)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int fallback = -1; uint console = WTSGetActiveConsoleSessionId();
    try {
      int size = Marshal.SizeOf(typeof(Session));
      for (int index = 0; index < count; index++) {
        Session session = (Session)Marshal.PtrToStructure(IntPtr.Add(sessions, index * size), typeof(Session));
        if (session.state != 0) continue;
        if (session.id == (int)console) return session.id;
        if (fallback < 0) fallback = session.id;
      }
    } finally { WTSFreeMemory(sessions); }
    return fallback;
  }
}
'@
}
$consoleSession = [OpenClawActiveSession]::Get()
if ($consoleSession -le 0) { throw 'Cloud worker requires an active interactive Windows session; reprovision the desktop worker' }
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($userSid -ne [OpenClawActiveSession]::UserSid($consoleSession)) { throw 'Cloud worker active Windows account changed; reprovision the desktop worker' }
`;

// Crabbox owns the privileged session switch. Keep one request producer for setup
// and enrollment, and retain cancellation evidence when the service outcome is unknown.
function interactiveScript(script: string, preparation = ""): string {
  const inner = `param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
$expectedSid = '__CRABBOX_EXPECTED_SID__'
$expectedSession = __CRABBOX_EXPECTED_SESSION__
$cancelPath = $ResultPath + '.cancel'
function Assert-LaunchCurrent {
  if (Test-Path -LiteralPath $cancelPath) { throw 'Cloud desktop launch was cancelled' }
  ${sessionIdentity}
  if ($userSid -ne $expectedSid -or $consoleSession -ne $expectedSession -or [Diagnostics.Process]::GetCurrentProcess().SessionId -ne $expectedSession) { throw 'Cloud desktop active account or session changed; reprovision the worker' }
}
function Write-LaunchResult($value) {
  $temporary = $ResultPath + '.tmp'
  [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $ResultPath
}
try {
  Assert-LaunchCurrent
  ${script}
} catch {
  Write-LaunchResult @{ error = $_.Exception.Message }
  exit 1
}`;
  return `$ErrorActionPreference = 'Stop'
${sessionIdentity}
$service = Get-Service -Name CrabboxDesktopLauncher -ErrorAction Stop
if ($service.Status -ne 'Running') { throw 'CrabboxDesktopLauncher is not running; reprovision the Windows desktop worker' }
$base = 'C:\\ProgramData\\crabbox'
$identity = 'desktop-launch-' + [Guid]::NewGuid().ToString('N')
$scriptPath = Join-Path $base ($identity + '.ps1')
$resultPath = Join-Path $base ($identity + '.result')
$cancelPath = $resultPath + '.cancel'
$request = Join-Path (Join-Path $base 'desktop-launch-requests') ($identity + '.request')
$requestTemporary = $request + '.tmp'
$source = ${quote(inner)}
${preparation}
$source = $source.Replace('__CRABBOX_EXPECTED_SID__', $userSid).Replace('__CRABBOX_EXPECTED_SESSION__', [string]$consoleSession)
$settled = $false
try {
  [IO.File]::WriteAllText($scriptPath, $source, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllLines($requestTemporary, @($scriptPath, $resultPath), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $requestTemporary -Destination $request
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $resultPath)) {
    [IO.File]::WriteAllText($cancelPath, 'cancelled')
    Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw 'Cloud desktop launch outcome could not be confirmed; release and reprovision the worker' }
  }
  $raw = [IO.File]::ReadAllText($resultPath).Trim()
  $settled = $true
  if ($raw.StartsWith('CRABBOX_DESKTOP_ERROR message=')) { throw [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Substring('CRABBOX_DESKTOP_ERROR message='.Length))) }
  $result = $raw | ConvertFrom-Json
  if ($result.error) { throw $result.error }
  if (Test-Path -LiteralPath $cancelPath) {
    if ($result.pid) {
      $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $result.pid)
      if ($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $result.startTime) { Stop-Process -Id $result.pid -Force }
    }
    throw 'Cloud desktop launch was cancelled; release and reprovision the worker'
  }
  Write-Output $raw
} finally {
  Remove-Item -LiteralPath $requestTemporary -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue
  if ($settled) { @($scriptPath, $resultPath, $cancelPath) | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue } }
}`;
}

const vncIdentity = String.raw`
$vncExecutable = 'C:\Program Files\TightVNC\tvnserver.exe'
function Assert-VncProcess($process, [string]$argument, [int]$session, [string]$sid) {
  $command = '^"?' + [regex]::Escape($vncExecutable) + '"?\s+' + [regex]::Escape($argument) + '[ \t]*$'
  if (-not $process -or -not $process.CreationDate -or $process.ExecutablePath -ine $vncExecutable -or $process.CommandLine -notmatch $command -or $process.SessionId -ne $session -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5).Sid -ne $sid) { throw 'Cloud desktop VNC process identity changed; reprovision the worker' }
}
function Get-WorkerVnc([string]$sid, [int]$session) {
  $listeners = @(Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue)
  if (-not $listeners.Count) { return $null }
  $owners = @($listeners.OwningProcess | Sort-Object -Unique)
  if ($owners.Count -ne 1 -or @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count) { throw 'Cloud desktop VNC requires one worker-owned loopback listener' }
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owners[0]) -OperationTimeoutSec 5
  Assert-VncProcess $process '-run' $session $sid
  return $process
}
`;

// Only OpenClaw's exclusive desktop leases hand VNC to the interactive account.
// Service credentials stay in this administrative context, outside launcher requests.
const prepareVnc = `${vncIdentity}
if (-not (Test-Path -LiteralPath $vncExecutable -PathType Leaf)) { throw 'Crabbox TightVNC is unavailable; reprovision the Windows desktop worker' }
$serviceKey = Get-Item -LiteralPath 'HKLM:\\Software\\TightVNC\\Server'
if (Test-Path -LiteralPath 'HKLM:\\Software\\TightVNC\\Server\\ServiceOnly') { throw 'The Windows image forbids TightVNC application mode; prepare an image that permits interactive VNC' }
$vncSettings = @{ UseVncAuthentication = 1; UseControlAuthentication = 1; RfbPort = 5900; AcceptRfbConnections = 1; AllowLoopback = 1; LoopbackOnly = 1; AcceptHttpConnections = 0; UseD3D = 0; UseMirrorDriver = 0; RemoveWallpaper = 0 }
$credentials = @{}
foreach ($name in @('Password', 'ControlPassword')) {
  $value = $serviceKey.GetValue($name)
  if ($serviceKey.GetValueKind($name) -ne 'Binary' -or $value.Length -ne 8) { throw 'Crabbox VNC credentials are unavailable; reprovision the worker' }
  $credentials[$name] = $value
}
foreach ($name in @('UseVncAuthentication', 'UseControlAuthentication')) {
  if ($serviceKey.GetValueKind($name) -ne 'DWord' -or $serviceKey.GetValue($name) -ne 1) { throw 'Crabbox VNC authentication is not enabled; reprovision the worker' }
}
$vncService = Get-Service -Name tvnserver
$serviceCommand = (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\tvnserver').ImagePath
if ($serviceCommand -notmatch ('^"?' + [regex]::Escape($vncExecutable) + '"?\\s+-service$')) { throw 'Crabbox VNC service executable changed; reprovision the worker' }
if ($vncService.Status -eq 'Running') {
  if (-not ('OpenClawVncService' -as [type])) {
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpenClawVncService {
  [StructLayout(LayoutKind.Sequential)] struct Status { public uint type, state, accepted, error, specificError, checkpoint, waitHint, pid, flags; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service, int level, out Status status, int size, out int needed);
  public static uint ProcessId(IntPtr service) { Status status; int needed; if (!QueryServiceStatusEx(service, 0, out status, Marshal.SizeOf(typeof(Status)), out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); return status.pid; }
}
'@
  }
  $servicePid = [OpenClawVncService]::ProcessId($vncService.ServiceHandle.DangerousGetHandle())
  $serviceProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $servicePid) -OperationTimeoutSec 5
  Assert-VncProcess $serviceProcess '-service' 0 'S-1-5-18'
  $serviceBirth = $serviceProcess.CreationDate
  $listeners = @(Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue)
  if (@($listeners | Where-Object { $_.OwningProcess -ne $servicePid }).Count) { throw 'Cloud desktop VNC port belongs to another process' }
  $serviceProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $servicePid) -OperationTimeoutSec 5
  Assert-VncProcess $serviceProcess '-service' 0 'S-1-5-18'
  if ($serviceProcess.CreationDate -ne $serviceBirth -or [OpenClawVncService]::ProcessId($vncService.ServiceHandle.DangerousGetHandle()) -ne $servicePid -or [OpenClawActiveSession]::Get() -ne $consoleSession -or [OpenClawActiveSession]::UserSid($consoleSession) -ne $userSid) { throw 'Cloud desktop changed before VNC service handover' }
  $vncService.Stop()
  $vncService.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(15))
} elseif ($vncService.Status -ne 'Stopped') { throw 'Crabbox VNC service is transitioning; reprovision the worker' }
$existingVnc = Get-WorkerVnc $userSid $consoleSession
if ([OpenClawActiveSession]::Get() -ne $consoleSession -or [OpenClawActiveSession]::UserSid($consoleSession) -ne $userSid) { throw 'Cloud desktop changed before VNC configuration' }
Set-Service -Name tvnserver -StartupType Disabled
$userKeyPath = 'Registry::HKEY_USERS\\' + $userSid + '\\Software\\TightVNC\\Server'
if (-not $existingVnc) {
  if (Test-Path -LiteralPath $userKeyPath) { Remove-Item -LiteralPath $userKeyPath -Recurse -Force }
  New-Item -Path $userKeyPath -Force | Out-Null
  foreach ($name in $vncSettings.Keys) { New-ItemProperty -LiteralPath $userKeyPath -Name $name -PropertyType DWord -Value $vncSettings[$name] -Force | Out-Null }
  foreach ($name in $credentials.Keys) { New-ItemProperty -LiteralPath $userKeyPath -Name $name -PropertyType Binary -Value $credentials[$name] -Force | Out-Null }
}
$userKey = Get-Item -LiteralPath $userKeyPath
foreach ($name in $vncSettings.Keys) {
  if ($userKey.GetValueKind($name) -ne 'DWord' -or $userKey.GetValue($name) -ne $vncSettings[$name]) { throw 'Cloud desktop VNC settings changed; reprovision the worker' }
}
foreach ($name in $credentials.Keys) {
  if ($userKey.GetValueKind($name) -ne 'Binary' -or [Convert]::ToBase64String($userKey.GetValue($name)) -cne [Convert]::ToBase64String($credentials[$name])) { throw 'Cloud desktop VNC credentials changed; reprovision the worker' }
}
# ConvertFrom-Json coerces ISO timestamps to DateTime; decimal text preserves exact birth ticks.
$expectedVnc = if ($existingVnc) { @{ pid = [int]$existingVnc.ProcessId; birthTicks = [string]$existingVnc.CreationDate.ToUniversalTime().Ticks } } else { $null }
$source = $source.Replace('__CRABBOX_VNC_IDENTITY__', (ConvertTo-Json -InputObject $expectedVnc -Compress))
`;

function browserLauncher(leaseId: string): string {
  return `$ErrorActionPreference = 'Stop'
if ($args.Count) { throw 'OpenClaw worker browser does not accept arguments' }
$profile = ${quote(`${desktopDirectory(leaseId)}\\browser-profile`)}
$browser = '__CRABBOX_BROWSER_EXECUTABLE__'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$lock = $null
$lockDeadline = [DateTime]::UtcNow.AddSeconds(25)
while (-not $lock) {
  try { $lock = [IO.File]::Open((Join-Path $profile 'launch.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch [IO.IOException] { if ([DateTime]::UtcNow -ge $lockDeadline) { throw }; Start-Sleep -Milliseconds 100 }
}
try {
  $endpoint = 'http://127.0.0.1:${WINDOWS_CDP_PORT}/json/version'
  $caller = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)
  $callerSid = [string](Invoke-CimMethod -InputObject $caller -MethodName GetOwnerSid).Sid
  if ($caller.SessionId -le 0 -or -not $callerSid.StartsWith('S-1-')) { throw 'Cloud browser requires its interactive Windows account and session' }
  $profileValue = [regex]::Escape($profile)
  $profilePattern = '(?:^|\\s)(?:"--user-data-dir=' + $profileValue + '"|--user-data-dir="' + $profileValue + '"'
  if ($profile -notmatch '\\s') { $profilePattern += '|--user-data-dir=' + $profileValue }
  $profilePattern += ')(?=\\s|$)'
  function Get-OwnedBrowserListener {
    $listeners = @(Get-NetTCPConnection -LocalPort ${WINDOWS_CDP_PORT} -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $false }
    $owners = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($owners.Count -ne 1 -or @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count) { throw 'Cloud browser CDP must have one worker-owned loopback listener' }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owners[0])
    $ownerSid = [string](Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid).Sid
    if (-not $owner.ExecutablePath -or -not [string]::Equals([IO.Path]::GetFullPath($owner.ExecutablePath), [IO.Path]::GetFullPath($browser), [StringComparison]::OrdinalIgnoreCase) -or $owner.SessionId -ne $caller.SessionId -or $ownerSid -ne $callerSid -or $owner.CommandLine -notmatch $profilePattern -or $owner.CommandLine -notmatch '(?:^|\\s)"?--remote-debugging-port=${WINDOWS_CDP_PORT}"?(?=\\s|$)') { throw 'CDP port belongs to another browser, profile, or Windows session; reprovision the desktop worker' }
    return $true
  }
  if (-not (Get-OwnedBrowserListener)) {
    Start-Process -FilePath $browser -ArgumentList @('--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--hide-crash-restore-bubble', ('--user-data-dir="' + $profile + '"'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=${WINDOWS_CDP_PORT}', 'about:blank') | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Get-OwnedBrowserListener) {
      try { Invoke-RestMethod -Uri $endpoint -TimeoutSec 1 | Out-Null; $ready = $true } catch { $ready = $false }
      if ($ready -and (Get-OwnedBrowserListener)) { exit 0 }
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Browser CDP did not become ready on 127.0.0.1:${WINDOWS_CDP_PORT} within 20 seconds'
} finally { $lock.Dispose() }`;
}

export function createCrabboxWindowsDesktopSetup(leaseId: string, wallpaperBase64: string): string {
  const directory = desktopDirectory(leaseId);
  const browser = browserLauncher(leaseId);
  const terminal = `$ErrorActionPreference = 'Stop'
if ($args.Count) { throw 'OpenClaw worker terminal does not accept arguments' }
$child = Start-Process -FilePath ${quote(WINDOWS_POWERSHELL)} -ArgumentList '-NoLogo -NoProfile -NoExit' -WindowStyle Normal -PassThru
Start-Sleep -Milliseconds 200
if ($child.HasExited) { throw 'Cloud worker terminal exited before becoming ready' }`;
  return interactiveScript(
    `$directory = ${quote(directory)}
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  icacls.exe $directory /inheritance:r /grant ('*' + $expectedSid + ':(OI)(CI)F') /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cloud desktop launcher directory permissions could not be secured' }
  $browserPaths = @()
  foreach ($name in @('chrome.exe', 'msedge.exe')) {
    $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $browserPaths += $command.Source }
  }
  $programDirectories = @($env:ProgramFiles, \${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
  foreach ($relative in @('Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe')) {
    foreach ($root in $programDirectories) { $browserPaths += Join-Path $root $relative }
  }
  $browserExecutable = $browserPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $browserExecutable -or -not [IO.Path]::IsPathRooted($browserExecutable)) { throw 'Crabbox desktop browser is unavailable; reprovision the worker with browser support' }
  [IO.File]::WriteAllText((Join-Path $directory 'browser.ps1'), ${quote(browser)}.Replace('__CRABBOX_BROWSER_EXECUTABLE__', $browserExecutable.Replace("'", "''")), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $directory 'terminal.ps1'), ${quote(terminal)}, [Text.UTF8Encoding]::new($false))
  $wallpaper = Join-Path $directory 'wallpaper.png'
  [IO.File]::WriteAllBytes($wallpaper, [Convert]::FromBase64String(${quote(wallpaperBase64)}))
  if (-not ('OpenClawWallpaper' -as [type])) { Add-Type 'using System; using System.Runtime.InteropServices; public static class OpenClawWallpaper { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SystemParametersInfo(uint action, uint parameter, string value, uint flags); }' }
  Assert-LaunchCurrent
  if (-not [OpenClawWallpaper]::SystemParametersInfo(20, 0, $wallpaper, 3)) { throw 'Cloud worker wallpaper could not be applied' }
  ${vncIdentity}
  $startedVnc = $null
  try {
    Assert-LaunchCurrent
    $expectedVnc = ConvertFrom-Json '__CRABBOX_VNC_IDENTITY__'
    $vnc = Get-WorkerVnc $expectedSid $expectedSession
    if ($expectedVnc) {
      if (-not $vnc -or $vnc.ProcessId -ne $expectedVnc.pid -or [string]$vnc.CreationDate.ToUniversalTime().Ticks -ne $expectedVnc.birthTicks) { throw 'Cloud desktop VNC changed during setup handover; reprovision the worker' }
    } elseif ($vnc) { throw 'Cloud desktop VNC appeared during setup handover; reprovision the worker' }
    if (-not $vnc) {
      Assert-LaunchCurrent
      $startedVnc = Start-Process -FilePath $vncExecutable -ArgumentList '-run' -PassThru
      $vnc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $startedVnc.Id) -OperationTimeoutSec 5
      Assert-VncProcess $vnc '-run' $expectedSession $expectedSid
    }
    $vncBirth = $vnc.CreationDate
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Assert-LaunchCurrent
      $listener = Get-WorkerVnc $expectedSid $expectedSession
      if ($listener) {
        if ($listener.ProcessId -ne $vnc.ProcessId -or $listener.CreationDate -ne $vncBirth) { throw 'Cloud desktop VNC changed before becoming ready' }
        if ((Get-Service -Name tvnserver).Status -ne 'Stopped') { throw 'Crabbox VNC service resumed during desktop setup' }
        Assert-LaunchCurrent
        $result = @{ status = 'ready' }
        if ($startedVnc) { $result.pid = [int]$vnc.ProcessId; $result.startTime = $vncBirth.ToUniversalTime().ToString('o') }
        Write-LaunchResult $result
        break
      }
      if ($startedVnc -and $startedVnc.HasExited) { throw 'Cloud desktop VNC exited before becoming ready' }
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Cloud desktop VNC did not listen on 127.0.0.1:5900 within 15 seconds' }
      Start-Sleep -Milliseconds 100
    } while ($true)
  } catch {
    if ($startedVnc -and -not $startedVnc.HasExited) { $startedVnc.Kill() }
    throw
  } finally { if ($startedVnc) { $startedVnc.Dispose() } }`,
    prepareVnc,
  );
}

export function createCrabboxWindowsDesktopEndpoint(leaseId: string): WorkerDesktopEndpoint {
  const directory = desktopDirectory(leaseId);
  const args = (name: string) => [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `${directory}\\${name}.ps1`,
  ];
  return {
    protocol: "rfb",
    port: 5900,
    allowsResize: false,
    passwordFilePath: String.raw`C:\ProgramData\crabbox\vnc.password`,
    apps: [
      {
        id: "browser",
        executablePath: WINDOWS_POWERSHELL,
        args: args("browser"),
        cdpPort: WINDOWS_CDP_PORT,
      },
      { id: "terminal", executablePath: WINDOWS_POWERSHELL, args: args("terminal") },
    ],
  };
}

export function createCrabboxWindowsDesktopNodeLauncher(): string {
  const launch =
    interactiveScript(`$options = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CRABBOX_NODE_OPTIONS__')))
  $nodeScript = $PSCommandPath + '.cjs'
  try {
    [IO.File]::WriteAllText($nodeScript, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CRABBOX_NODE_SOURCE__')), [Text.UTF8Encoding]::new($false))
    $env:OPENCLAW_STATE_DIR = $options.stateDir
    Assert-LaunchCurrent
    $nodeResult = & $options.nodePath $nodeScript $cancelPath $expectedSession $expectedSid
    if ($LASTEXITCODE -ne 0) { throw 'Cloud worker interactive node launcher failed' }
    Write-LaunchResult ($nodeResult | ConvertFrom-Json)
  } finally { Remove-Item -LiteralPath $nodeScript -Force -ErrorAction SilentlyContinue }`);
  const nodeSource = String.raw`const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const options = __CRABBOX_OPTIONS__;
const [, , cancelPath, expectedSession, expectedSid] = process.argv;
if (fs.existsSync(cancelPath)) throw new Error("Cloud desktop launch was cancelled");
const log = fs.openSync(options.logPath, "a");
const child = spawn(options.nodePath, options.nodeArgs, { cwd: options.cwd, env: { ...process.env, OPENCLAW_STATE_DIR: options.stateDir }, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
child.once("error", error => { fs.closeSync(log); console.error(error.message); process.exitCode = 1; });
child.once("spawn", () => {
  fs.closeSync(log);
  try {
    const script = "$ErrorActionPreference = 'Stop'; $node = Get-CimInstance Win32_Process -Filter 'ProcessId=" + child.pid + "'; if (-not $node) { throw 'Node process is unavailable' }; @{ pid = [int]$node.ProcessId; startTime = $node.CreationDate.ToUniversalTime().ToString('o'); sessionId = [int]$node.SessionId; userSid = [string](Invoke-CimMethod -InputObject $node -MethodName GetOwnerSid).Sid; executablePath = $node.ExecutablePath } | ConvertTo-Json -Compress";
    const probe = spawnSync(process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    if (probe.error || probe.status !== 0) throw new Error(probe.stderr?.trim() || "Cloud worker interactive node identity is unavailable");
    const identity = JSON.parse(probe.stdout.trim());
    if (identity.pid !== child.pid || identity.sessionId !== Number(expectedSession) || identity.userSid !== expectedSid || !identity.startTime || fs.realpathSync(identity.executablePath) !== fs.realpathSync(options.nodePath)) throw new Error("Cloud worker interactive node identity changed");
    if (fs.existsSync(cancelPath)) throw new Error("Cloud desktop launch was cancelled");
    delete identity.executablePath;
    process.stdout.write(JSON.stringify(identity));
    child.unref();
  } catch (error) { child.kill(); console.error(error.message); process.exitCode = 1; }
});`;
  return `function runWindowsDesktopPowerShell(script) {
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "openclaw-desktop-"));
  try {
    const scriptPath = path.join(directory, "launch.ps1");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = require("node:child_process").spawnSync(${JSON.stringify(WINDOWS_POWERSHELL)}, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { encoding: "utf8", windowsHide: true, timeout: 95000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || "Cloud worker Windows desktop launch failed");
    return JSON.parse(result.stdout.trim());
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function readWindowsDesktopSessionIdentity() {
  const result = runWindowsDesktopPowerShell(${JSON.stringify(`$ErrorActionPreference = 'Stop'
${sessionIdentity}
@{ sessionId = [int]$consoleSession; userSid = $userSid } | ConvertTo-Json -Compress`)});
  if (!Number.isSafeInteger(result.sessionId) || result.sessionId < 1 || typeof result.userSid !== "string" || !/^S-1-/.test(result.userSid)) throw new Error("Cloud worker interactive session identity is invalid");
  return result;
}
async function launchWindowsDesktopNode(options) {
  const source = ${JSON.stringify(nodeSource)}.replace("__CRABBOX_OPTIONS__", () => JSON.stringify(options));
  const result = runWindowsDesktopPowerShell(${JSON.stringify(launch)}.replace("__CRABBOX_NODE_OPTIONS__", Buffer.from(JSON.stringify(options)).toString("base64")).replace("__CRABBOX_NODE_SOURCE__", Buffer.from(source).toString("base64")));
  if (!Number.isSafeInteger(result.pid) || result.pid < 1 || !Number.isSafeInteger(result.sessionId) || result.sessionId < 1 || typeof result.startTime !== "string" || !result.startTime || typeof result.userSid !== "string" || !/^S-1-/.test(result.userSid)) throw new Error("Cloud worker interactive node identity is invalid");
  return result;
}`;
}
