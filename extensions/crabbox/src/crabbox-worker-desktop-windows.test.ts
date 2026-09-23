import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxWindowsDesktopNodeLauncher,
  createCrabboxWindowsDesktopSetup,
} from "./crabbox-worker-desktop-windows.js";

const require = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
const options = {
  nodePath,
  nodeArgs: [String.raw`C:\Users\crabbox\runtime\openclaw.mjs`, "connect", "--ephemeral"],
  cwd: String.raw`C:\Users\crabbox\runtime`,
  stateDir: String.raw`C:\Users\crabbox\.openclaw\cloud-workers\cbx_fixture`,
  logPath: String.raw`C:\Users\crabbox\.openclaw\cloud-workers\cbx_fixture\node.log`,
};
const identity = {
  pid: 412,
  sessionId: 2,
  userSid: "S-1-5-21-123-456-789-1001",
  startTime: "2026-09-18T12:34:56.1234567Z",
};

function launcher(result: { status: number; stdout?: string; stderr?: string }) {
  let source = "";
  const mockFs = {
    mkdtempSync: () => String.raw`C:\Users\crabbox\AppData\Local\Temp\openclaw-desktop-fixture`,
    writeFileSync: (_file: string, value: string) => {
      source = value;
    },
    rmSync: vi.fn(),
  };
  const run = vi.fn(() => result);
  const runtime = runInNewContext(
    `${createCrabboxWindowsDesktopNodeLauncher()}
({ launch: launchWindowsDesktopNode, inspect: readWindowsDesktopSessionIdentity })`,
    {
      Buffer,
      require: (name: string) => {
        if (name === "node:fs") {
          return mockFs;
        }
        if (name === "node:path") {
          return path.win32;
        }
        if (name === "node:os") {
          return { tmpdir: () => String.raw`C:\Users\crabbox\AppData\Local\Temp` };
        }
        if (name === "node:child_process") {
          return { spawnSync: run };
        }
        return require(name);
      },
    },
  ) as {
    launch: (input: typeof options) => Promise<typeof identity>;
    inspect: () => { sessionId: number; userSid: string };
  };
  return { ...runtime, fs: mockFs, source: () => source };
}

describe("Windows desktop node service handoff", () => {
  it("returns the interactive process identity and removes its temporary caller script", async () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await expect(runtime.launch(options)).resolves.toEqual(identity);
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });

  it("delivers literal replacement tokens and apostrophes to the generated node process", async () => {
    const literal = "$& $` $' worker's";
    const requested = {
      nodePath: path.win32.join("C:\\", literal, "node.exe"),
      nodeArgs: [...options.nodeArgs, "--display-name", literal],
      cwd: path.win32.join(options.cwd, literal),
      stateDir: path.win32.join(options.stateDir, literal),
      logPath: path.win32.join(options.stateDir, literal, "node.log"),
    };
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await runtime.launch(requested);
    // Inspect the actual script bytes delivered through Crabbox's PowerShell request.
    const delivered = [...runtime.source().matchAll(/FromBase64String\(''([A-Za-z0-9+/=]+)''\)/gu)]
      .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
      .filter((value) => !value.startsWith("{"));
    expect(delivered).toHaveLength(1);
    const openLog = vi.fn(() => 11);
    const spawnNode = vi.fn(() => ({ once: vi.fn() }));
    runInNewContext(delivered[0]!, {
      Buffer,
      process: {
        argv: [requested.nodePath, "launch.cjs", "cancel-marker", "2", identity.userSid],
        env: {},
      },
      require: (name: string) => {
        if (name === "node:fs") {
          return { existsSync: () => false, openSync: openLog };
        }
        if (name === "node:child_process") {
          return { spawn: spawnNode };
        }
        throw new Error(`Unexpected launcher dependency: ${name}`);
      },
    });
    expect(openLog).toHaveBeenCalledWith(requested.logPath, "a");
    expect(spawnNode).toHaveBeenCalledExactlyOnceWith(requested.nodePath, requested.nodeArgs, {
      cwd: requested.cwd,
      env: { OPENCLAW_STATE_DIR: requested.stateDir },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", 11, 11],
    });
  });

  it.each([
    { name: "Session 0", changed: { sessionId: 0 } },
    { name: "missing process creation time", changed: { startTime: "" } },
    { name: "missing account identity", changed: { userSid: "" } },
    { name: "invalid process identifier", changed: { pid: -1 } },
  ])("rejects $name rather than advertising a usable desktop", async ({ changed }) => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify({ ...identity, ...changed }) });
    await expect(runtime.launch(options)).rejects.toThrow("interactive node identity is invalid");
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });

  it("rejects a missing interactive session during replay inspection", () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify({ ...identity, sessionId: 0 }) });
    expect(() => runtime.inspect()).toThrow("interactive session identity is invalid");
  });

  it("preserves service failure diagnostics and cleans the temporary caller script", async () => {
    const runtime = launcher({
      status: 1,
      stderr:
        "Cloud desktop launch outcome could not be confirmed; release and reprovision the worker",
    });
    await expect(runtime.launch(options)).rejects.toThrow("outcome could not be confirmed");
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });
});

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
    stdio: "ignore",
  }).status === 0;

describe.skipIf(!hasPowerShell)("generated Windows PowerShell syntax", () => {
  it("parses setup, nested app launchers, and enrollment using the installed PowerShell parser", async () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await runtime.launch(options);
    const scripts = [
      createCrabboxWindowsDesktopSetup("cbx_fixture", "c3ludGhldGlj"),
      runtime.source(),
    ];
    const parser = String.raw`
$ErrorActionPreference = 'Stop'
function Check-Script([string]$text) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  foreach ($literal in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains([char]10) -and ($node.Value.StartsWith('param(') -or $node.Value.StartsWith('$ErrorActionPreference')) }, $true)) { Check-Script $literal.Value }
}
foreach ($script in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) { Check-Script $script }
`;
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", parser], {
      input: JSON.stringify(scripts),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect({ code: result.status, errors: result.stderr }).toEqual({ code: 0, errors: "" });
  });
});

describe.skipIf(!hasPowerShell)("Windows browser launcher ownership", () => {
  it.each([
    { scenario: "reuse", passed: true, launches: 0 },
    { scenario: "launch", passed: true, launches: 1 },
    { scenario: "reduced-environment", passed: true, launches: 1 },
    { scenario: "different-profile", passed: false, launches: 0 },
    { scenario: "different-binary", passed: false, launches: 0 },
    { scenario: "different-account", passed: false, launches: 0 },
    { scenario: "different-session", passed: false, launches: 0 },
    { scenario: "public-listener", passed: false, launches: 0 },
    { scenario: "changed-after-response", passed: false, launches: 1 },
  ])("$scenario", ({ scenario, passed, launches }) => {
    const root = tempDirs.make("windows-browser-owner-");
    const browser = path.join(root, "browser's.exe");
    fs.writeFileSync(browser, "synthetic executable identity; never executed");
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Find-LauncherExpression([string]$text) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
  if($errors.Count){ throw ($errors | Out-String) }
  $writes=@($ast.FindAll({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'WriteAllText' -and $node.Arguments[0].Extent.Text.Contains("'browser.ps1'") },$true))
  if($writes.Count){ return $writes[0].Arguments[1].Extent.Text }
  foreach($literal in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.StartsWith('param(') },$true)){ $found=Find-LauncherExpression $literal.Value; if($found){ return $found } }
  return $null
}
$expression=Find-LauncherExpression $fixture.setup
if(-not $expression){throw 'Setup did not install a browser launcher'}
$browserExecutable=$fixture.browser
$source=& ([scriptblock]::Create('return '+$expression))
# Map only the lease-owned filesystem root; execute the installed script unchanged otherwise.
$source=$source.Replace('C:\ProgramData\OpenClaw\cloud-workers\cbx_fixture\desktop\browser-profile',(Join-Path $fixture.root 'profile data'))
$launcher=Join-Path $fixture.root 'browser.ps1'
[IO.File]::WriteAllText($launcher,$source)
$env:BROWSER=$fixture.browser
$env:CHROME_BIN=$fixture.browser
$env:ProgramFiles=$fixture.root
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $fixture.root, 'Process')
$env:LOCALAPPDATA=Join-Path $fixture.root 'profile data'
if($fixture.scenario -eq 'reduced-environment') {
  foreach($name in @('LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','BROWSER','CHROME_BIN')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
}
$global:launches=0
$global:responded=$false
function Get-NetTCPConnection {
  if($fixture.scenario -in @('launch','reduced-environment','changed-after-response') -and $global:launches -eq 0){return}
  [pscustomobject]@{LocalAddress=$(if($fixture.scenario -eq 'public-listener'){'0.0.0.0'}else{'127.0.0.1'});OwningProcess=700}
}
function Get-CimInstance {
  param($ClassName,$Filter)
  if($Filter -eq ('ProcessId='+$PID)){return [pscustomobject]@{ProcessId=$PID;SessionId=2;Sid='S-1-5-21-1001'}}
  $profile=Join-Path $fixture.root 'profile data'
  if($fixture.scenario -eq 'different-profile' -or ($fixture.scenario -eq 'changed-after-response' -and $global:responded)){$profile+='-other'}
  [pscustomobject]@{
    ProcessId=700
    SessionId=$(if($fixture.scenario -eq 'different-session'){3}else{2})
    Sid=$(if($fixture.scenario -eq 'different-account'){'S-1-5-21-2001'}else{'S-1-5-21-1001'})
    ExecutablePath=$(if($fixture.scenario -eq 'different-binary'){Join-Path $fixture.root 'other.exe'}else{$fixture.browser})
    CommandLine=('"'+$fixture.browser+'" --user-data-dir="'+$profile+'" --remote-debugging-port=9222')
  }
}
function Invoke-CimMethod { param($InputObject,$MethodName) [pscustomobject]@{Sid=$InputObject.Sid} }
function Start-Process { $global:launches++ }
function Invoke-RestMethod { $global:responded=$true; [pscustomobject]@{Browser='Synthetic Chrome'} }
try { & $launcher; $passed=$true; $message=$null } catch { $passed=$false; $message=$_.Exception.Message }
@{passed=$passed;launches=$global:launches;message=$message} | ConvertTo-Json -Compress
`;
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", harness], {
      input: JSON.stringify({
        scenario,
        root,
        browser,
        setup: createCrabboxWindowsDesktopSetup("cbx_fixture", "c3ludGhldGlj"),
      }),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect({ code: result.status, errors: result.stderr }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ passed, launches });
  });
});

describe.skipIf(!hasPowerShell)("Windows desktop VNC handover", () => {
  it("hands over authenticated VNC, preserves replay, and rejects changed or cancelled ownership", () => {
    const cases = [
      { scenario: "launch", passed: true, launches: 1, stops: 1, kills: 0 },
      { scenario: "launcher-command-whitespace", passed: true, launches: 1, stops: 1, kills: 0 },
      { scenario: "reuse", passed: true, launches: 0, stops: 0, kills: 0 },
      { scenario: "replay-pid-change", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "replay-birth-change", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "fresh-listener-appeared", passed: false, launches: 0, stops: 1, kills: 0 },
      { scenario: "service-only", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "service-birth-change", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "account-before-stop", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "session-after-stop", passed: false, launches: 0, stops: 1, kills: 0 },
      { scenario: "account-after-discovery", passed: false, launches: 0, stops: 1, kills: 0 },
      { scenario: "missing-auth", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "wrong-account", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "wrong-session", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "wrong-arguments", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "public-listener", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "changed-settings", passed: false, launches: 0, stops: 0, kills: 0 },
      { scenario: "cancel-launch", passed: false, launches: 1, stops: 1, kills: 1 },
      { scenario: "cancel-during-discovery", passed: false, launches: 0, stops: 1, kills: 0 },
      { scenario: "cancel-reuse", passed: false, launches: 0, stops: 0, kills: 0 },
    ];
    const root = tempDirs.make("windows-vnc-owner-");
    const browser = path.join(root, "browser.exe");
    fs.writeFileSync(browser, "synthetic executable identity; never executed");
    // Execute the generated administrative request and its interactive script,
    // substituting only Windows APIs and the disposable filesystem root.
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
$fixtures = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($fixture in $fixtures) {
$global:launches=0; $global:stops=0; $global:kills=0; $global:reads=0; $global:configures=0; $global:writes=0
$global:registry=@{}
$sid='S-1-5-21-1001'
$image='C:\Program Files\TightVNC\tvnserver.exe'
$birth=[DateTime]::Parse('2026-09-18T12:34:56Z')
function New-WorkerVnc { [pscustomobject]@{ ProcessId=700; CreationDate=$birth; ExecutablePath=$image; CommandLine=('"'+$image+'" -run'); SessionId=2; Sid=$sid } }
$global:app=New-WorkerVnc
$global:serviceProcess=[pscustomobject]@{ ProcessId=400; CreationDate=$birth; ExecutablePath=$image; CommandLine=('"'+$image+'" -service'); SessionId=0; Sid='S-1-5-18' }
$global:service=[pscustomobject]@{ Status='Stopped'; ServiceHandle=[pscustomobject]@{} }
$global:service.ServiceHandle | Add-Member ScriptMethod DangerousGetHandle { return [IntPtr]::Zero }
$global:service | Add-Member ScriptMethod Stop { $global:stops++; $this.Status='Stopped' }
$global:service | Add-Member ScriptMethod WaitForStatus { if($fixture.scenario -eq 'session-after-stop') { [OpenClawActiveSession]::Session=3 } }
$settings=@{ UseVncAuthentication=1; UseControlAuthentication=1; RfbPort=5900; AcceptRfbConnections=1; AllowLoopback=1; LoopbackOnly=1; AcceptHttpConnections=0; UseD3D=0; UseMirrorDriver=0; RemoveWallpaper=0; Password=[byte[]](1..8); ControlPassword=[byte[]](8..1) }
foreach($name in $settings.Keys) { $global:registry[$name]=$settings[$name] }
if ($fixture.scenario -in @('launch','launcher-command-whitespace','fresh-listener-appeared','cancel-launch','cancel-during-discovery','service-birth-change','account-before-stop','session-after-stop','account-after-discovery')) { $global:app=$null; $global:service.Status='Running'; $global:registry=@{} }
switch ($fixture.scenario) {
  'wrong-account' { $global:app.Sid='S-1-5-21-2001' }
  'wrong-session' { $global:app.SessionId=3 }
  'wrong-arguments' { $global:app.CommandLine+=' -service' }
  'changed-settings' { $global:registry.UseD3D=1 }
}
if (-not ('OpenClawActiveSession' -as [type])) { Add-Type @'
public static class OpenClawActiveSession { public static int Session=2; public static string Sid="S-1-5-21-1001"; public static int Get() { return Session; } public static string UserSid(int session) { return Sid; } }
public static class OpenClawVncService { public static uint ProcessId(System.IntPtr service) { return 400; } }
public static class OpenClawWallpaper { public static bool SystemParametersInfo(uint a,uint b,string c,uint d) { return true; } }
'@
}
[OpenClawActiveSession]::Session=2
[OpenClawActiveSession]::Sid=$sid
function Get-Service { param($Name) if($Name -eq 'tvnserver') { return $global:service }; return [pscustomobject]@{Status='Running'} }
function Set-Service { $global:configures++ }
function Get-CimInstance {
  param($ClassName,$Filter,$OperationTimeoutSec)
  if($Filter -eq 'ProcessId=400') {
    $global:reads++
    if($fixture.scenario -eq 'service-birth-change' -and $global:reads -gt 1) { $global:serviceProcess.CreationDate=$birth.AddSeconds(1) }
    if($fixture.scenario -eq 'account-before-stop' -and $global:reads -gt 1) { [OpenClawActiveSession]::Sid='S-1-5-21-2001' }
    return $global:serviceProcess
  }
  if($global:app -and $Filter -eq ('ProcessId='+$global:app.ProcessId)) { return $global:app }
  throw "Unexpected process inspection: $Filter"
}
function Invoke-CimMethod { param($InputObject,$MethodName,$OperationTimeoutSec) [pscustomobject]@{Sid=$InputObject.Sid} }
function Get-NetTCPConnection {
  param($LocalPort,$State,$ErrorAction)
  if ($LocalPort -ne 5900 -or $State -ne 'Listen') { throw 'Unexpected listener inspection' }
  if($fixture.scenario -eq 'cancel-during-discovery' -and $ResultPath) { [IO.File]::WriteAllText(($ResultPath+'.cancel'),'cancelled') }
  if($fixture.scenario -eq 'account-after-discovery' -and $global:service.Status -eq 'Stopped') { [OpenClawActiveSession]::Sid='S-1-5-21-2001' }
  if($global:service.Status -eq 'Running') { return [pscustomobject]@{LocalAddress='0.0.0.0';OwningProcess=400} }
  if($global:app) { return [pscustomobject]@{ LocalAddress=$(if($fixture.scenario -eq 'public-listener'){'0.0.0.0'}else{'127.0.0.1'}); OwningProcess=$global:app.ProcessId } }
}
function Get-ItemProperty { [pscustomobject]@{ImagePath=('"'+$image+'" -service')} }
function Get-Item {
  param($LiteralPath)
  $key=[pscustomobject]@{ Service=$LiteralPath.StartsWith('HKLM:') }
  $key | Add-Member ScriptMethod GetValue {
    param($name)
    if($this.Service) {
      if($name -in @('Password','ControlPassword')) { return $settings[$name] }
      if($fixture.scenario -eq 'missing-auth') { return 0 }
      return 1
    }
    return $global:registry[$name]
  }
  $key | Add-Member ScriptMethod GetValueKind { param($name) if($name -in @('Password','ControlPassword')) { return 'Binary' }; return 'DWord' }
  return $key
}
function Test-Path {
  param($LiteralPath,$PathType)
  if($LiteralPath -eq $image) { return $true }
  if($LiteralPath.EndsWith('\ServiceOnly')) { return $fixture.scenario -eq 'service-only' }
  if($LiteralPath.StartsWith('Registry::')) { return $global:registry.Count -gt 0 }
  return Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function New-Item {
  param($Path,$ItemType,[switch]$Force)
  if($Path.StartsWith('Registry::')) { $global:writes++; return }
  Microsoft.PowerShell.Management\New-Item @PSBoundParameters
}
function New-ItemProperty { param($LiteralPath,$Name,$PropertyType,$Value,[switch]$Force) $global:writes++; $global:registry[$Name]=$Value }
function Remove-Item {
  param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction)
  if($LiteralPath.StartsWith('Registry::')) { $global:writes++; $global:registry=@{}; return }
  Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
}
function Move-Item {
  param($LiteralPath,$Destination)
  Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
  if($Destination.EndsWith('.request')) {
    if($fixture.scenario -eq 'replay-pid-change') { $global:app.ProcessId=701 }
    if($fixture.scenario -eq 'replay-birth-change') { $global:app.CreationDate=$birth.AddSeconds(1) }
    if($fixture.scenario -eq 'fresh-listener-appeared') { $global:app=New-WorkerVnc }
    $request=[IO.File]::ReadAllLines($Destination)
    & $request[0] -ResultPath $request[1]
  }
  if($Destination.EndsWith('.result') -and $fixture.scenario -eq 'cancel-reuse') { [IO.File]::WriteAllText(($Destination+'.cancel'),'cancelled') }
}
function Get-Command { [pscustomobject]@{Source=$fixture.browser} }
function icacls.exe { $global:LASTEXITCODE=0 }
function Start-Process {
  param($FilePath,$ArgumentList,[switch]$PassThru)
  if($FilePath -ne $image -or $ArgumentList -ne '-run') { throw 'Unexpected process launch' }
  $global:launches++
  $global:app=New-WorkerVnc
  if ($fixture.scenario -eq 'launcher-command-whitespace') { $global:app.CommandLine+=' ' }
  $child=[pscustomobject]@{Id=700;HasExited=$false}
  $child | Add-Member ScriptMethod Kill { $global:kills++; $global:app=$null; $this.HasExited=$true }
  $child | Add-Member ScriptMethod Dispose {}
  if($fixture.scenario -eq 'cancel-launch') { [IO.File]::WriteAllText(($ResultPath+'.cancel'),'cancelled') }
  return $child
}
function Stop-Process { $global:kills++; $global:app=$null }
$source=$fixture.setup.Replace('C:\ProgramData\OpenClaw\cloud-workers\cbx_fixture\desktop',(Join-Path $fixture.root 'desktop')).Replace('C:\ProgramData\crabbox',$fixture.root)
$source=$source.Replace('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',('$sid')).Replace('[Diagnostics.Process]::GetCurrentProcess().SessionId','2')
$setup=Join-Path $fixture.root 'setup.ps1'
[IO.File]::WriteAllText($setup,$source)
New-Item -ItemType Directory -Path (Join-Path $fixture.root 'desktop-launch-requests') -Force | Out-Null
$env:ProgramFiles=$fixture.root
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)',$fixture.root,'Process')
try { $output=& $setup; $passed=$true; $message=$null } catch { $passed=$false; $message=$_.Exception.Message }
@{scenario=$fixture.scenario;passed=$passed;launches=$global:launches;stops=$global:stops;kills=$global:kills;configures=$global:configures;writes=$global:writes;settings=$global:registry;message=$message} | ConvertTo-Json -Compress
}
`;
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", harness], {
      input: JSON.stringify(
        cases.map(({ scenario }) => ({
          scenario,
          root,
          browser,
          setup: createCrabboxWindowsDesktopSetup("cbx_fixture", "c3ludGhldGlj"),
        })),
      ),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect({ code: result.status, errors: result.stderr }).toEqual({ code: 0, errors: "" });
    const results = result.stdout
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(results).toHaveLength(cases.length);
    for (const expected of cases) {
      const observed = results.find((entry) => entry.scenario === expected.scenario);
      expect(observed, expected.scenario).toMatchObject(expected);
      if (
        ["account-before-stop", "session-after-stop", "account-after-discovery"].includes(
          expected.scenario,
        )
      ) {
        expect(observed).toMatchObject({ configures: 0, writes: 0 });
      }
      if (expected.passed) {
        expect(observed.settings).toEqual({
          UseVncAuthentication: 1,
          UseControlAuthentication: 1,
          Password: [1, 2, 3, 4, 5, 6, 7, 8],
          ControlPassword: [8, 7, 6, 5, 4, 3, 2, 1],
          RfbPort: 5900,
          AcceptRfbConnections: 1,
          AllowLoopback: 1,
          LoopbackOnly: 1,
          AcceptHttpConnections: 0,
          UseD3D: 0,
          UseMirrorDriver: 0,
          RemoveWallpaper: 0,
        });
      } else {
        const errors: Record<string, string> = {
          "replay-pid-change": "VNC changed during setup handover",
          "replay-birth-change": "VNC changed during setup handover",
          "fresh-listener-appeared": "VNC appeared during setup handover",
          "service-only": "forbids TightVNC application mode",
          "service-birth-change": "changed before VNC service handover",
          "account-before-stop": "changed before VNC service handover",
          "session-after-stop": "changed before VNC configuration",
          "account-after-discovery": "changed before VNC configuration",
          "missing-auth": "authentication is not enabled",
          "wrong-account": "VNC process identity changed",
          "wrong-session": "VNC process identity changed",
          "wrong-arguments": "VNC process identity changed",
          "public-listener": "one worker-owned loopback listener",
          "changed-settings": "VNC settings changed",
          "cancel-launch": "launch was cancelled",
          "cancel-during-discovery": "launch was cancelled",
          "cancel-reuse": "launch was cancelled",
        };
        expect(observed.message, expected.scenario).toContain(errors[expected.scenario]);
      }
    }
  });
});
