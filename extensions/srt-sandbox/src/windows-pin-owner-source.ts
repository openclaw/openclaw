// SRT Windows pin owner program source (design v8 §4, AC-S6-2).
//
// The Windows analogue of PIN_OWNER_PYTHON (pin-owner-source.ts): a persistent
// per-scope pin owner that provides the AC4 exact-location guarantee via live
// directory HANDLES. Each path segment is opened with NtCreateFile +
// OBJECT_ATTRIBUTES.RootDirectory=<parent handle> + FILE_OPEN_REPARSE_POINT and
// kept open from resolve to mutate/finalize; the mutation runs relative to the
// held parent handle (exclusive create = FILE_CREATE; rename =
// NtSetInformationFile(FileRenameInformation) with the destination RootDirectory
// handle). A Windows handle binds the file object like a Unix vnode, so a
// post-resolve rename/replace/reparse swap of a held component cannot redirect
// the mutation and a removed target fails closed. FILE_ID_INFO is auxiliary
// corroboration only, never the guarantee.
//
// It speaks the SAME newline-delimited JSON RPC as the POSIX owner
// (resolve/mutate/release/read/stat/rename/ping/shutdown), so the platform-
// agnostic fs-bridge (fs-bridge.ts) and PinOwnerClient (pin-owner-client.ts)
// drive it unchanged. Launched INSIDE the sandbox via \`srt-win exec\` as the
// scope's low-privilege account, so every NtCreateFile it issues is also
// NTFS-ACL enforced against that account's SID — the held-handle model composes
// with, never bypasses, the Windows account/ACL enforcement.
//
// Verified on real Windows 11 ARM64: NtCreateFile live-handle escape resistance
// (real-dir swap, junction swap, removed-target fail-closed), rename, full
// protocol parity, no leaked handles.
//
// NB: this is a PLAIN template literal, not String.raw. The program text below
// is escaped for a cooked template (`\\` = one backslash, `` \` `` = one
// backtick), so the runtime string carries SINGLE backslashes — the exact form
// PowerShell needs for NT paths (`\??\`), the `/`→`\` normalizer, and the
// CommandLineToArgvW quoter. An earlier revision wrapped the identical
// (double-escaped) body in String.raw, which leaves the backslashes DOUBLED at
// runtime and breaks NtCreateFile path resolution (STATUS_OBJECT_NAME_INVALID)
// and Quote-Arg's `[char]` compares. windows-source-roundtrip.test.ts pins the
// runtime form so this cannot regress.
export const PIN_OWNER_POWERSHELL = `
# SRT Windows pin owner (design v8 §4, AC-S6-2) — NtCreateFile live-handle pin.
#
# Protocol-compatible with the POSIX pin owner / PinOwnerClient (resolve, mutate,
# release, read, stat, rename, ping, shutdown) over newline-delimited JSON on
# stdin/stdout, so the existing platform-agnostic fs-bridge drives it unchanged.
#
# The exact-location guarantee comes from live directory HANDLES: each path
# segment is opened with NtCreateFile + OBJECT_ATTRIBUTES.RootDirectory=<parent
# handle> + FILE_OPEN_REPARSE_POINT, kept open from resolve to mutate/finalize,
# and the mutation runs relative to the held parent handle (exclusive create =
# FILE_CREATE, rename = SetFileInformationByHandle(FILE_RENAME_INFO) with the
# destination RootDirectory handle). A Windows handle binds the file object like
# a Unix vnode, so a post-resolve rename/replace/reparse swap of a held component
# cannot redirect the mutation; a removed target fails closed. FILE_ID_INFO is
# auxiliary corroboration only. The owner is launched INSIDE the sandbox (via
# \`srt-win exec\`, as the scope's low-priv account), so every NtCreateFile it
# issues is additionally NTFS-ACL enforced against that account's SID.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Srt {
  [StructLayout(LayoutKind.Sequential)]
  public struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  public struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }

  public static class PinOwner {
    const uint FILE_LIST_DIRECTORY   = 0x0001;
    const uint FILE_TRAVERSE         = 0x0020;
    const uint FILE_READ_ATTRIBUTES  = 0x0080;
    const uint FILE_WRITE_DATA       = 0x0002;
    const uint FILE_READ_DATA        = 0x0001;
    const uint SYNCHRONIZE           = 0x00100000;
    const uint READ_CONTROL          = 0x00020000;
    const uint DELETE                = 0x00010000;
    const uint FILE_DIRECTORY_FILE        = 0x00000001;
    const uint FILE_NON_DIRECTORY_FILE    = 0x00000040;
    const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    const uint FILE_OPEN_REPARSE_POINT    = 0x00200000;
    const uint FILE_OPEN       = 1;
    const uint FILE_CREATE     = 2;
    const uint FILE_OPEN_IF    = 3;
    const uint FILE_OVERWRITE_IF = 5;
    const uint FILE_SHARE_ALL   = 0x00000007;
    const uint OBJ_CASE_INSENSITIVE = 0x00000040;

    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out IntPtr h, uint access, ref OBJECT_ATTRIBUTES oa, out IO_STATUS_BLOCK iosb, IntPtr alloc, uint attrs, uint share, uint disp, uint opts, IntPtr ea, uint eaLen);
    [DllImport("ntdll.dll")] static extern int NtClose(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr h, out IO_STATUS_BLOCK iosb, IntPtr info, uint len, int cls);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(IntPtr h, int cls, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, IntPtr info, uint size);

    static IntPtr AllocUnicode(string s, out IntPtr strBuf) {
      byte[] bytes = Encoding.Unicode.GetBytes(s);
      strBuf = Marshal.AllocHGlobal(bytes.Length + 2);
      Marshal.Copy(bytes, 0, strBuf, bytes.Length);
      Marshal.WriteInt16(strBuf, bytes.Length, 0);
      UNICODE_STRING us = new UNICODE_STRING();
      us.Length = (ushort)bytes.Length; us.MaximumLength = (ushort)(bytes.Length + 2); us.Buffer = strBuf;
      IntPtr usPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(us, usPtr, false);
      return usPtr;
    }

    static IntPtr Open(IntPtr root, string name, uint access, uint disp, uint opts, out int status) {
      IntPtr strBuf, usPtr = AllocUnicode(name, out strBuf);
      try {
        OBJECT_ATTRIBUTES oa = new OBJECT_ATTRIBUTES();
        oa.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
        oa.RootDirectory = root; oa.ObjectName = usPtr; oa.Attributes = OBJ_CASE_INSENSITIVE;
        IntPtr h; IO_STATUS_BLOCK iosb;
        status = NtCreateFile(out h, access, ref oa, out iosb, IntPtr.Zero, 0, FILE_SHARE_ALL, disp, opts, IntPtr.Zero, 0);
        return status == 0 ? h : IntPtr.Zero;
      } finally { Marshal.FreeHGlobal(usPtr); Marshal.FreeHGlobal(strBuf); }
    }

    const uint FILE_ADD_FILE         = 0x0002;
    const uint FILE_ADD_SUBDIRECTORY = 0x0004;
    const uint DIR_ACCESS = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE | READ_CONTROL | DELETE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
    const uint DIR_OPTS   = FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;

    public static IntPtr OpenRoot(string ntPath, out int status) { return Open(IntPtr.Zero, ntPath, DIR_ACCESS, FILE_OPEN, DIR_OPTS, out status); }
    public static IntPtr OpenChildDir(IntPtr parent, string name, out int status) { return Open(parent, name, DIR_ACCESS, FILE_OPEN, DIR_OPTS, out status); }
    public static IntPtr MakeChildDir(IntPtr parent, string name, out int status) { return Open(parent, name, DIR_ACCESS, FILE_OPEN_IF, DIR_OPTS, out status); }

    public static int WriteLeaf(IntPtr parent, string leaf, byte[] data, bool excl, out bool existed) {
      existed = false; int status;
      IntPtr h = Open(parent, leaf, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, excl ? FILE_CREATE : FILE_OVERWRITE_IF,
        FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, out status);
      if (status != 0) {
        // STATUS_OBJECT_NAME_COLLISION on exclusive create = "exists" (not an error).
        if (excl && (uint)status == 0xC0000035) { existed = true; return 0; }
        return status;
      }
      try { using (var sfh = new SafeFileHandle(h, true)) using (var fs = new FileStream(sfh, FileAccess.Write)) { fs.Write(data, 0, data.Length); fs.Flush(); } }
      catch { try { NtClose(h); } catch {} throw; }
      return 0;
    }

    public static byte[] ReadByPath(string ntPath, out int status) {
      IntPtr h = Open(IntPtr.Zero, ntPath, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, out status);
      if (status != 0) return null;
      using (var sfh = new SafeFileHandle(h, true)) using (var fs = new FileStream(sfh, FileAccess.Read)) using (var ms = new MemoryStream()) { fs.CopyTo(ms); return ms.ToArray(); }
    }

    // FILE_RENAME_INFORMATION (native, class 10) supports a RootDirectory HANDLE
    // so BOTH source and destination stay pinned to held handles (the Win32
    // SetFileInformationByHandle wrapper rejects a RootDirectory handle here).
    // Layout on x64/arm64: [ReplaceIfExists(1)+pad(7)][RootDirectory(8)][FileNameLength(4)][FileName...]
    public static int RenameAt(IntPtr parentFrom, string fromLeaf, IntPtr parentTo, string toLeaf, bool replace) {
      int status;
      IntPtr src = Open(parentFrom, fromLeaf, DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES, FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, out status);
      if (status != 0) return status;
      try {
        byte[] name = Encoding.Unicode.GetBytes(toLeaf);
        int off_root = 8, off_len = 8 + IntPtr.Size, off_name = off_len + 4;
        int size = off_name + name.Length;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try {
          for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
          Marshal.WriteByte(buf, 0, (byte)(replace ? 1 : 0));
          Marshal.WriteIntPtr(buf, off_root, parentTo);
          Marshal.WriteInt32(buf, off_len, name.Length);
          Marshal.Copy(name, 0, (IntPtr)(buf.ToInt64() + off_name), name.Length);
          IO_STATUS_BLOCK iosb;
          int st = NtSetInformationFile(src, out iosb, buf, (uint)size, 10 /* FileRenameInformation */);
          return st;
        } finally { Marshal.FreeHGlobal(buf); }
      } finally { NtClose(src); }
    }

    static int DeleteHandle(IntPtr h) {
      IntPtr buf = Marshal.AllocHGlobal(4);
      try { Marshal.WriteInt32(buf, 0, 1); if (!SetFileInformationByHandle(h, 4, buf, 4)) return Marshal.GetLastWin32Error() | unchecked((int)0x40000000); return 0; }
      finally { Marshal.FreeHGlobal(buf); }
    }

    // Enumerate immediate child names of a held directory handle (FileFullDirectoryInfo=14).
    public static List<string> Enumerate(IntPtr dir) {
      var names = new List<string>();
      int bufSize = 64 * 1024; IntPtr buf = Marshal.AllocHGlobal(bufSize);
      try {
        while (GetFileInformationByHandleEx(dir, 14, buf, (uint)bufSize)) {
          long off = 0;
          while (true) {
            IntPtr entry = (IntPtr)(buf.ToInt64() + off);
            int next = Marshal.ReadInt32(entry, 0);
            int nameLen = Marshal.ReadInt32(entry, 60); // FileNameLength (FILE_FULL_DIR_INFO)
            string nm = Marshal.PtrToStringUni((IntPtr)(entry.ToInt64() + 68), nameLen / 2); // FileName after EaSize(4)
            if (nm != "." && nm != "..") names.Add(nm);
            if (next == 0) break; off += next;
          }
        }
        return names;
      } finally { Marshal.FreeHGlobal(buf); }
    }

    public static bool IsDir(IntPtr parent, string leaf) {
      int status;
      IntPtr h = OpenChildDir(parent, leaf, out status);
      if (status == 0) { NtClose(h); return true; }
      return false;
    }

    public static int RemoveAt(IntPtr parent, string leaf, bool recursive) {
      int status;
      // Try as directory first (recursive) then fall through to file.
      if (recursive) {
        IntPtr dh = Open(parent, leaf, DIR_ACCESS | FILE_LIST_DIRECTORY, FILE_OPEN, DIR_OPTS, out status);
        if (status == 0) {
          try { foreach (var child in Enumerate(dh)) { int cs = RemoveAt(dh, child, true); if (cs != 0) return cs; } return DeleteHandle(dh); }
          finally { NtClose(dh); }
        }
      }
      IntPtr h = Open(parent, leaf, DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES, FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, out status);
      if (status != 0) return status;
      try { return DeleteHandle(h); } finally { NtClose(h); }
    }

    public static long[] StatByPath(string ntPath, out int status) {
      // returns [type(0=file,1=dir,2=other), size, mtime100ns] or null.
      IntPtr h = Open(IntPtr.Zero, ntPath, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT, out status);
      if (status != 0) return null;
      try {
        int size = 40; IntPtr buf = Marshal.AllocHGlobal(size); // FILE_BASIC_INFO(40) via class 0
        try {
          // FILE_STANDARD_INFO (class 1): AllocationSize(8) EndOfFile(8) NumberOfLinks(4) DeletePending(1) Directory(1)
          int stdSize = 24; IntPtr stdBuf = Marshal.AllocHGlobal(stdSize);
          try {
            if (!GetFileInformationByHandleEx(h, 1, stdBuf, (uint)stdSize)) { status = -1; return null; }
            long eof = Marshal.ReadInt64(stdBuf, 8);
            byte isDir = Marshal.ReadByte(stdBuf, 21);
            // mtime via FILE_BASIC_INFO (class 0): Creation(8) LastAccess(8) LastWrite(8) Change(8) Attrs(4)
            long mtime = 0;
            if (GetFileInformationByHandleEx(h, 0, buf, (uint)size)) mtime = Marshal.ReadInt64(buf, 16);
            return new long[] { isDir != 0 ? 1 : 0, eof, mtime };
          } finally { Marshal.FreeHGlobal(stdBuf); }
        } finally { Marshal.FreeHGlobal(buf); }
      } finally { NtClose(h); }
    }

    public static void Close(IntPtr h) { if (h != IntPtr.Zero) NtClose(h); }
  }
}
'@

function To-NtPath([string]$p) {
  if ($p -like '\\\\?\\*') { return '\\??\\' + $p.Substring(4) }
  if ($p -like '\\\\*')   { return '\\??\\UNC\\' + $p.Substring(2) }
  return '\\??\\' + $p
}
# fs-bridge passes canonical POSIX-style roots (e.g. C:/Users/..); normalize to Win32.
function To-Win32([string]$p) { return ($p -replace '/', '\\') }

$held = @{}

function Respond($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

function Walk-Hold([string]$root, [string]$rel) {
  $status = 0
  $rh = [Srt.PinOwner]::OpenRoot((To-NtPath (To-Win32 $root)), [ref]$status)
  if ($status -ne 0) { throw "open root failed: NTSTATUS 0x$('{0:X8}' -f $status)" }
  $handles = New-Object System.Collections.ArrayList
  [void]$handles.Add($rh)
  try {
    $segs = @(); if ($rel) { $segs = $rel -split '[\\\\/]+' | Where-Object { $_ -ne '' } }
    if ($segs.Count -gt 256) { throw 'pin depth exceeds maximum' }
    foreach ($seg in $segs) {
      if ($seg -eq '.' -or $seg -eq '..' -or $seg.Contains([char]0)) { throw 'invalid path component' }
      $ch = [Srt.PinOwner]::OpenChildDir($handles[$handles.Count-1], $seg, [ref]$status)
      if ($status -ne 0) { throw "open segment '$seg' failed: NTSTATUS 0x$('{0:X8}' -f $status)" }
      [void]$handles.Add($ch)
    }
  } catch { foreach ($h in $handles) { [Srt.PinOwner]::Close($h) }; throw }
  return ,$handles
}

function Release-Op($opId) {
  if ($held.ContainsKey($opId)) { foreach ($h in $held[$opId].handles) { [Srt.PinOwner]::Close($h) }; $held.Remove($opId) }
}

# mkdir mode: rel="" (root held) and leaf is the whole suffix chain to create.
function Do-Mkdir($parent, [string]$suffix) {
  $cur = $parent; $opened = @()
  try {
    foreach ($seg in ($suffix -split '[\\\\/]+' | Where-Object { $_ -ne '' })) {
      if ($seg -eq '.' -or $seg -eq '..') { throw 'invalid path component' }
      $status = 0
      $nfd = [Srt.PinOwner]::MakeChildDir($cur, $seg, [ref]$status)
      if ($status -ne 0) { throw "mkdir '$seg' failed: 0x$('{0:X8}' -f $status)" }
      $opened += $nfd; $cur = $nfd
    }
  } finally { foreach ($h in $opened) { [Srt.PinOwner]::Close($h) } }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim(); if ($line -eq '') { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { Respond @{ id=$null; ok=$false; error="bad request: $_" }; continue }
  $rid = $req.id; $op = $req.op
  try {
    switch ($op) {
      'shutdown' { Respond @{ id=$rid; ok=$true; result='bye' }; break }
      'ping'     { Respond @{ id=$rid; ok=$true; pong=$true; pid=$PID; held=$held.Count; fds=-1 } }
      'resolve'  {
        $opId = $req.opId
        if ($held.ContainsKey($opId)) { throw 'opId already held' }
        $handles = Walk-Hold $req.root $req.rel
        $held[$opId] = @{ handles=$handles; leaf=$req.leaf; mode=$req.mode }
        Respond @{ id=$rid; ok=$true; opId=$opId; depth=$handles.Count }
      }
      'mutate'   {
        $opId = $req.opId
        if (-not $held.ContainsKey($opId)) { throw 'no held pin for opId' }
        try {
          $entry = $held[$opId]; $parent = $entry.handles[$entry.handles.Count-1]; $leaf = $entry.leaf; $kind = $req.kind
          $result = ''
          switch ($kind) {
            'create' {
              $data = if ($req.data) { [Convert]::FromBase64String($req.data) } else { New-Object byte[] 0 }
              $existed = $false
              $st = [Srt.PinOwner]::WriteLeaf($parent, $leaf, $data, $true, [ref]$existed)
              if ($st -ne 0) { throw "create failed: 0x$('{0:X8}' -f $st)" }
              $result = if ($existed) { 'exists' } else { 'created' }
            }
            'write' {
              $data = if ($req.data) { [Convert]::FromBase64String($req.data) } else { New-Object byte[] 0 }
              $existed = $false
              $st = [Srt.PinOwner]::WriteLeaf($parent, $leaf, $data, $false, [ref]$existed)
              if ($st -ne 0) { throw "write failed: 0x$('{0:X8}' -f $st)" }
              $result = 'created'
            }
            'mkdir'  { Do-Mkdir $parent $leaf; $result = 'created' }
            'remove' {
              $recursive = [bool]$req.recursive; $force = if ($null -ne $req.force) { [bool]$req.force } else { $true }
              $st = [Srt.PinOwner]::RemoveAt($parent, $leaf, $recursive)
              if ($st -ne 0) {
                # STATUS_OBJECT_NAME_NOT_FOUND with force => absent (idempotent).
                if ($force -and ((([uint32]$st) -eq 0xC0000034) -or (([uint32]$st) -eq 0xC000003A))) { $result = 'absent' }
                else { throw "remove failed: 0x$('{0:X8}' -f $st)" }
              } else { $result = 'removed' }
            }
            default { throw "unknown mutate kind: $kind" }
          }
          Respond @{ id=$rid; ok=$true; result=$result }
        } finally { Release-Op $opId }
      }
      'release'  { Release-Op $req.opId; Respond @{ id=$rid; ok=$true } }
      'read'     {
        $status = 0
        $bytes = [Srt.PinOwner]::ReadByPath((To-NtPath (To-Win32 $req.path)), [ref]$status)
        if ($status -ne 0) { throw "read failed: 0x$('{0:X8}' -f $status)" }
        Respond @{ id=$rid; ok=$true; data=[Convert]::ToBase64String($bytes) }
      }
      'stat'     {
        $status = 0
        $s = [Srt.PinOwner]::StatByPath((To-NtPath (To-Win32 $req.path)), [ref]$status)
        if ($null -eq $s) { Respond @{ id=$rid; ok=$true; stat=$null } }
        else {
          $type = switch ($s[0]) { 1 { 'directory' } 0 { 'file' } default { 'other' } }
          # Windows FILETIME (100ns since 1601) -> ms since 1970.
          $mtimeMs = ($s[2] / 10000.0) - 11644473600000.0
          Respond @{ id=$rid; ok=$true; stat=@{ type=$type; size=$s[1]; mtimeMs=$mtimeMs } }
        }
      }
      'rename'   {
        $src = Walk-Hold $req.fromRoot $req.fromRel
        $dst = $null
        try {
          $dst = Walk-Hold $req.toRoot $req.toRel
          $st = [Srt.PinOwner]::RenameAt($src[$src.Count-1], $req.fromLeaf, $dst[$dst.Count-1], $req.toLeaf, $true)
          if ($st -ne 0) { throw "rename failed: 0x$('{0:X8}' -f $st)" }
          Respond @{ id=$rid; ok=$true; result='renamed' }
        } finally {
          foreach ($h in $src) { [Srt.PinOwner]::Close($h) }
          if ($dst) { foreach ($h in $dst) { [Srt.PinOwner]::Close($h) } }
        }
      }
      default    { Respond @{ id=$rid; ok=$false; error="unknown op: $op" } }
    }
  } catch { Respond @{ id=$rid; ok=$false; error="$_" } }
}

`;

/** Filename the pin-owner program is staged under, inside a scope-readable dir. */
export const WINDOWS_PIN_OWNER_SCRIPT_NAME = ".srt-sandbox-pin-owner.ps1";

/**
 * Absolute path to Windows PowerShell. srt-win's runner launches the target via
 * \`CreateProcessAsUserW\` with a non-NULL \`lpApplicationName\`, which does NOT
 * perform a PATH search and does NOT append \`.exe\` — so a bare \`powershell\`
 * target fails with \`0x80070002\` (ERROR_FILE_NOT_FOUND). Resolve the full
 * System32 path (verified on real Windows 11 ARM64: bare name fails, full path
 * launches). Uses SystemRoot so it is correct regardless of the Windows install
 * drive.
 */
export function resolveWindowsPowerShellPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * Build the inner argv that \`srt-win exec\` runs to launch the persistent
 * Windows pin owner from a STAGED script file (written by the caller; see
 * WindowsSrtSandboxBackend.spawnPinOwner).
 *
 * The program is launched with \`powershell -File <path>\`, NOT
 * \`-EncodedCommand\`: the base64 of the ~18 KB UTF-16LE program is ~50 KB, which
 * blows past CreateProcessW's 32 767-char command-line limit — srt-win rejects
 * it as \`argv_too_long\` and a direct Node spawn returns ENAMETOOLONG. A
 * \`-File\` path keeps the launch argv small and constant. The caller wraps this
 * with wrapCommandWithSandboxWindows so the owner still runs as the scope
 * account under the WFP fence and NTFS ACLs; its stdin/stdout are the RPC
 * channel. \`scriptPath\` must live in a location the scope account can read
 * (a granted writable root).
 */
export function buildWindowsPinOwnerInnerArgs(scriptPath: string): string[] {
  return [
    resolveWindowsPowerShellPath(),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ];
}
