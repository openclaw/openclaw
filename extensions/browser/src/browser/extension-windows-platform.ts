import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertNoSymlinkParents,
  inspectPathPermissions,
  readSecureFile,
} from "openclaw/plugin-sdk/file-access-runtime";
import { z } from "zod";
import {
  isWindowsNativePath,
  sameWindowsPath,
  sidSchema,
  windowsPathSchema,
} from "./extension-windows-contract.js";

type WindowsIdentity = { localAppData: string; sid: string };
export type WindowsNativePlatform = {
  identity(this: void): Promise<WindowsIdentity>;
  assertPath(
    this: void,
    target: string,
    options: { kind: "file" | "directory"; private: boolean; allowMissing?: boolean },
  ): Promise<void>;
  readFile(this: void, target: string, maxBytes: number, privateFile?: boolean): Promise<Buffer>;
  listFiles(this: void, directory: string): Promise<string[]>;
  realpath(this: void, target: string): Promise<string>;
};
// Only OS identity discovery; no registry/file mutation, PATH lookup or policy override.
const IDENTITY_SCRIPT = String.raw`$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{
localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
})))`;
const identitySchema = z.strictObject({ localAppData: windowsPathSchema, sid: sidSchema });
export function createWindowsNativePlatform(
  env: NodeJS.ProcessEnv = process.env,
): WindowsNativePlatform {
  const inspect = async (script: string): Promise<string> => {
    const executable = path.win32.join(
      env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (process.platform !== "win32" || !isWindowsNativePath(executable)) {
      throw new Error("Windows OS inspection unavailable");
    }
    // This fixed OS query tool is the same bootstrap trust boundary used by
    // Windows ACL inspection itself. Protected Windows binaries may be owned by
    // TrustedInstaller, not by the private user-artifact owner set below.
    await assertNoSymlinkParents({
      rootDir: path.win32.parse(executable).root,
      targetPath: executable,
    });
    if (!(await fs.lstat(executable)).isFile()) {
      throw new Error("Windows OS inspection unavailable");
    }
    const { stdout } = await promisify(execFile)(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
    );
    return stdout;
  };
  const assertParents = async (target: string) => {
    // Creating unrelated siblings at a volume root is not authority to replace an
    // existing child. Inspect replacement rights, not a blanket writable bit.
    // TrustedInstaller owns protected OS ancestors; this does not admit it as
    // owner of a private generation or caller-selected Node/CLI/config file.
    const encoded = Buffer.from(path.win32.dirname(target)).toString("base64");
    await inspect(
      String.raw`$ErrorActionPreference='Stop'
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` +
        encoded +
        String.raw`'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
while($p){
 $acl=[IO.Directory]::GetAccessControl($p)
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Unsafe ancestor'}
 $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
 if($null -eq $raw.DiscretionaryAcl){throw 'Unverified ancestor'}
 foreach($ace in $raw.DiscretionaryAcl){
  if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or [int]$ace.AceType -notin @(0,1)){throw 'Unverified ancestor'}
  if([int]$ace.AceType -eq 0 -and ([int]$ace.AceFlags -band 8) -eq 0 -and $ace.SecurityIdentifier.Value -notin $trusted -and (([long]$ace.AccessMask -band 0x500d0150) -ne 0)){throw 'Unsafe ancestor writer'}
 }
 $parent=[IO.Directory]::GetParent($p)
 $p=if($null -eq $parent){$null}else{$parent.FullName}
}
`,
    );
  };
  const assertPath: WindowsNativePlatform["assertPath"] = async (target, options) => {
    if (process.platform !== "win32" || !isWindowsNativePath(target)) {
      throw new Error("Windows path unavailable");
    }
    await assertNoSymlinkParents({
      rootDir: path.win32.parse(target).root,
      targetPath: target,
      allowMissing: options.allowMissing,
    });
    const info = await fs.lstat(target).catch((error: unknown) => {
      if (
        options.allowMissing &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    });
    if (!info) {
      const parent = path.win32.dirname(target);
      if (parent === target) {
        throw new Error("Windows path unavailable");
      }
      await assertPath(parent, { kind: "directory", private: false, allowMissing: true });
      return;
    }
    if (
      info.isSymbolicLink() ||
      (options.kind === "file" ? !info.isFile() : !info.isDirectory()) ||
      !sameWindowsPath(await fs.realpath(target), target)
    ) {
      throw new Error("Windows path redirected");
    }
    const acl = await inspectPathPermissions(target, { platform: "win32", env });
    if (
      !acl.ok ||
      acl.source !== "windows-acl" ||
      acl.ownerTrusted !== true ||
      acl.groupWritable ||
      acl.worldWritable ||
      (options.private && (acl.groupReadable || acl.worldReadable))
    ) {
      throw new Error("Windows path ownership unavailable");
    }
    // A protected file can still be replaced through a writable parent.
    const parent = path.win32.dirname(target);
    if (parent !== target) {
      await assertParents(target);
    }
  };
  return {
    assertPath,
    async identity() {
      if (process.platform !== "win32") {
        throw new Error("Windows identity unavailable");
      }
      const stdout = await inspect(IDENTITY_SCRIPT);
      const value: unknown = JSON.parse(stdout);
      return identitySchema.parse(value);
    },
    async readFile(target, maxBytes, privateFile = true) {
      await assertPath(target, { kind: "file", private: privateFile });
      const { buffer } = await readSecureFile({
        filePath: target,
        permissions: { allowReadableByOthers: !privateFile },
        io: { maxBytes },
      });
      return buffer;
    },
    listFiles: (directory) => fs.readdir(directory),
    realpath: (target) => fs.realpath(target),
  };
}
