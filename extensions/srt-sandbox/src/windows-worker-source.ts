// SRT Windows per-scope worker program source (design v8 §5, AC-S6-4/AC-S6-6).
//
// The "true worker RPC architecture" the Windows path requires: a plugin-owned
// per-scope worker process that owns a Windows Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Every `srt-win exec` tree it launches is a
// job member (inherited at CreateProcess), so when the worker exits — on
// shutdown, on scope teardown (the reaper taskkills it), or on GATEWAY CRASH
// (a parent-process watch force-exits the worker the moment the Gateway pid
// dies, independent of the RPC loop) — the job closes and the whole tree
// (srt-win broker → runner → restricted child + background descendants) is
// force-killed. srt-win's own broker/runner kill-on-close jobs cascade the kill;
// this worker guarantees the outermost link (the Windows analogue of the POSIX
// liveness pipe + process-group reaper).
//
// Speaks newline-delimited JSON RPC over stdin/stdout (ready/exec/ping/shutdown),
// the same transport shape as the POSIX broker executor. The driver builds the
// sandboxed argv with wrapCommandWithSandboxWindows and sends it as `exec`.
//
// Verified on real Windows 11 ARM64: exec-as-scope-account, reap-on-worker-crash,
// and reap-on-gateway-crash (parent-watch → KILL_ON_JOB_CLOSE).
export const WINDOWS_WORKER_POWERSHELL = String.raw`
# SRT Windows per-scope worker (design v8 §5, AC-S6-4/AC-S6-6): the plugin-owned
# worker that owns a Job Object with KILL_ON_JOB_CLOSE. Every \`srt-win exec\` tree
# it spawns is a job member (inherited at CreateProcess), so when the worker exits
# — on shutdown, on scope teardown, or on GATEWAY CRASH (detected as stdin EOF) —
# the job closes and the whole tree (srt-win broker -> runner -> restricted child
# + any background descendant) is force-killed. srt-win's own broker/runner
# kill-on-close jobs cascade the kill; this worker guarantees the outermost link.
#
# Speaks newline-delimited JSON RPC over stdin/stdout (same transport shape as the
# POSIX broker executor): ready / exec / ping / shutdown.
# worker/shim/Gateway crash coverage (AC-S6-4): -ParentPid enables the Gateway
# liveness watch (force-exit on parent death); the Job Object reaps the tree.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace SrtJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public IntPtr MinimumWorkingSetSize; public IntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public IntPtr ProcessMemoryLimit; public IntPtr JobMemoryLimit; public IntPtr PeakProcessMemoryUsed; public IntPtr PeakJobMemoryUsed;
  }
  public static class Job {
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    // Force-exit this worker when the Gateway (parent) process dies, independent
    // of the RPC loop (which may be blocked in a long foreground exec). Our exit
    // closes the last Job handle => KILL_ON_JOB_CLOSE reaps the srt-win tree.
    // This is the Windows analogue of the POSIX liveness pipe (design v8 §5).
    public static void WatchParent(int pid) {
      if (pid <= 0) return;
      IntPtr ph = OpenProcess(0x00100000 /*SYNCHRONIZE*/, false, (uint)pid);
      if (ph == IntPtr.Zero) return;
      var t = new System.Threading.Thread(() => { WaitForSingleObject(ph, 0xFFFFFFFF); TerminateProcess(GetCurrentProcess(), 0); });
      t.IsBackground = true; t.Start();
    }
    public static IntPtr Create() {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
      var eli = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      eli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr p = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(eli, p, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)size))
          throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(p); }
      if (!AssignProcessToJobObject(job, GetCurrentProcess()))
        throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
      return job;
    }
  }
}
'@

# Own the Job Object: KILL_ON_JOB_CLOSE means the whole tree dies when this
# process (and thus the last job handle) goes away. Held for the process lifetime.
$script:job = [SrtJob.Job]::Create()
# Gateway liveness watch: force-exit (=> job close => reap) when the parent dies.
if ($ParentPid -le 0 -and $env:SRT_PARENT_PID) { $ParentPid = [int]$env:SRT_PARENT_PID }
[SrtJob.Job]::WatchParent($ParentPid)

function Respond($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

# Quote one argv element per CommandLineToArgvW rules (.NET Framework 4.8 has no
# ProcessStartInfo.ArgumentList, so we build the command-line string ourselves).
function Quote-Arg([string]$a) {
  if ($a -ne '' -and $a -notmatch '[ \\t\\n\\v"]') { return $a }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  for ($i = 0; $i -lt $a.Length; $i++) {
    $bs = 0
    while ($i -lt $a.Length -and $a[$i] -eq '\\') { $i++; $bs++ }
    if ($i -eq $a.Length) { [void]$sb.Append('\\', $bs * 2); break }
    elseif ($a[$i] -eq '"') { [void]$sb.Append('\\', $bs * 2 + 1); [void]$sb.Append('"') }
    else { [void]$sb.Append('\\', $bs); [void]$sb.Append($a[$i]) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Run-Exec($req) {
  $argv = @($req.argv)
  if ($argv.Count -lt 1) { return @{ ok=$false; error='exec requires argv' } }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$argv[0]
  if ($argv.Count -gt 1) { $psi.Arguments = (($argv[1..($argv.Count-1)] | ForEach-Object { Quote-Arg ([string]$_) }) -join ' ') }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  if ($req.cwd) { $psi.WorkingDirectory = [string]$req.cwd }
  if ($req.env) { $psi.EnvironmentVariables.Clear(); foreach ($k in $req.env.PSObject.Properties.Name) { $psi.EnvironmentVariables[$k] = [string]$req.env.$k } }
  $p = [System.Diagnostics.Process]::Start($psi)   # inherits our Job Object
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()
  if ($req.stdin) { $bytes=[Convert]::FromBase64String($req.stdin); $p.StandardInput.BaseStream.Write($bytes,0,$bytes.Length) }
  $p.StandardInput.Close()
  $timeoutMs = if ($req.timeoutMs) { [int]$req.timeoutMs } else { 120000 }
  $timedOut = $false
  if (-not $p.WaitForExit($timeoutMs)) { $timedOut = $true; try { $p.Kill($true) } catch { try { $p.Kill() } catch {} }; $p.WaitForExit(5000) | Out-Null }
  $so.Wait(); $se.Wait()
  $code = if ($timedOut) { 124 } else { $p.ExitCode }
  return @{
    ok = $true; code = $code; timedOut = $timedOut
    stdout = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($so.Result))
    stderr = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($se.Result))
  }
}

# Announce readiness so the driver can health-check spawn (fail-closed).
Respond @{ ready=$true; pid=$PID }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # stdin EOF => parent (Gateway) gone => exit => job closes => reap tree
  $line = $line.Trim(); if ($line -eq '') { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { Respond @{ id=$null; ok=$false; error="bad request: $_" }; continue }
  $rid = $req.id; $op = if ($req.op) { $req.op } else { 'exec' }
  try {
    switch ($op) {
      'shutdown' { Respond @{ id=$rid; ok=$true; result='bye' }; break }
      'ping'     { Respond @{ id=$rid; ok=$true; pong=$true; pid=$PID } }
      'exec'     { $out = Run-Exec $req; $out.id = $rid; Respond $out }
      default    { Respond @{ id=$rid; ok=$false; error="unknown op: $op" } }
    }
  } catch { Respond @{ id=$rid; ok=$false; error="$_" } }
}

`;

/**
 * Build the argv that launches the persistent Windows Job-Object worker. The
 * PowerShell program is passed as a UTF-16LE base64 `-EncodedCommand` so no
 * script file is staged on disk. The Gateway pid the worker watches for liveness
 * is passed via the `SRT_PARENT_PID` environment variable (see
 * {@link windowsWorkerEnv}), because `-EncodedCommand` consumes the rest of the
 * command line and cannot also bind a `-ParentPid` parameter.
 */
export function buildWindowsWorkerArgv(): string[] {
  const encoded = Buffer.from(WINDOWS_WORKER_POWERSHELL, "utf16le").toString("base64");
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

/** Env for the worker: the Gateway pid it force-exits on (Gateway-crash reap). */
export function windowsWorkerEnv(parentPid: number): NodeJS.ProcessEnv {
  return { ...process.env, SRT_PARENT_PID: String(parentPid) };
}
