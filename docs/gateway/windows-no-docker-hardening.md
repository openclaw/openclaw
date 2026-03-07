---
summary: "Fallback hardening for native Windows when Docker/WSL sandboxing is unavailable"
title: "Windows hardening without Docker/WSL"
read_when:
  - Running OpenClaw on native Windows
  - Unable to use Docker or WSL2 sandboxing
status: active
---

# Windows hardening without Docker/WSL

If you can use [Sandboxing](/gateway/sandboxing), use that first.

This guide is a **host hardening fallback** for native Windows when Docker/WSL
is unavailable or unreliable on the target machine. It does **not** provide a
container boundary. It is still better than running OpenClaw on the host with
no isolation plan at all.

## What this gives you

- a dedicated low-privilege Windows user for automation
- a dedicated workspace and state directory
- NTFS ACL allowlists on those directories
- a repeatable smoke test, forbidden-path test, and rollback flow

## What this does not give you

- container isolation
- protection against an admin user on the same machine
- protection if you keep running the gateway under your normal user
- protection from tools or workflows that intentionally bypass the boundary

If you enable host escapes such as elevated execution, this boundary becomes
much weaker.

## Threat model

This fallback is aimed at reducing **accidental or over-broad host access** on
native Windows:

- the model should be able to work inside one chosen workspace
- the model should not have routine access to unrelated directories
- the gateway should not run as a local administrator

This is primarily a blast-radius reduction measure, not a strong sandbox.

## Before you start

- Prefer [Windows (WSL2)](/platforms/windows) when possible.
- Prefer [Sandboxing](/gateway/sandboxing) when Docker is available.
- Use a dedicated workspace root such as `D:\OpenClawWorkspace`.
- Keep state/config under a dedicated path such as
  `D:\OpenClawWorkspace\.openclaw-state`.
- Do not run the gateway as a local administrator.

## 1. Create dedicated workspace and state paths

In PowerShell:

```powershell
$Workspace = "D:\OpenClawWorkspace"
$State = "D:\OpenClawWorkspace\.openclaw-state"

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
New-Item -ItemType Directory -Force -Path $State | Out-Null
```

## 2. Create a dedicated local user

Create a non-admin user for running OpenClaw:

```powershell
$BotUser = "openclaw_bot"
$Password = Read-Host "Password for $BotUser" -AsSecureString

New-LocalUser -Name $BotUser `
  -Password $Password `
  -PasswordNeverExpires `
  -UserMayNotChangePassword `
  -AccountNeverExpires `
  -Description "Constrained user for OpenClaw automation"
```

Require a password and make sure the user is not in `Administrators`:

```powershell
net user openclaw_bot /passwordreq:yes
Remove-LocalGroupMember -Group "Administrators" -Member "openclaw_bot" -ErrorAction SilentlyContinue
```

## 3. Grant access only where OpenClaw needs it

Grant modify access to the workspace and state paths:

```powershell
$Principal = "$env:COMPUTERNAME\openclaw_bot"

icacls $Workspace /grant "${Principal}:(OI)(CI)M" /T /C
icacls $State /grant "${Principal}:(OI)(CI)M" /T /C
```

If OpenClaw was installed in a per-user location, ensure the dedicated user can
also read/execute the OpenClaw and Node install directories. If possible,
prefer a machine-wide install so read/execute access is already available.

## 4. Optional: deny sibling directories under the same parent

If you keep the workspace under a parent folder with unrelated sibling
directories, you can explicitly deny access to those siblings:

```powershell
$Parent = Split-Path -Parent $Workspace
Get-ChildItem -LiteralPath $Parent -Directory |
  Where-Object { $_.FullName -ne $Workspace } |
  ForEach-Object {
    icacls $_.FullName /deny "${Principal}:(OI)(CI)F" /T /C
  }
```

This is optional, but it makes the boundary more explicit.

## 5. Keep OpenClaw state/config in the dedicated state path

When running the gateway as the dedicated user, point OpenClaw at the isolated
state/config location:

```powershell
$Workspace = "D:\OpenClawWorkspace"
$State = "D:\OpenClawWorkspace\.openclaw-state"

runas /user:$env:COMPUTERNAME\openclaw_bot "powershell -NoProfile -NoExit -Command `"`
`$env:OPENCLAW_STATE_DIR='$State'; `
`$env:OPENCLAW_CONFIG_PATH='$State\openclaw.json'; `
Set-Location -LiteralPath '$Workspace'; `
openclaw gateway`""
```

If you already configured models/channels under another profile, copy or
recreate the needed config for the dedicated user / state path before switching
the gateway over.

## 6. Verify the boundary

### Smoke test

The constrained user should be able to read the workspace:

```powershell
runas /user:$env:COMPUTERNAME\openclaw_bot "powershell -NoProfile -Command `"Get-ChildItem -LiteralPath 'D:\OpenClawWorkspace' | Select-Object -First 3`""
```

### Forbidden-path test

The constrained user should not have broad access to unrelated directories you
intentionally blocked:

```powershell
runas /user:$env:COMPUTERNAME\openclaw_bot "powershell -NoProfile -Command `"Get-ChildItem -LiteralPath '$env:USERPROFILE'`""
```

### Runtime sanity check

Run normal health checks after starting the gateway:

```powershell
openclaw doctor
openclaw status
```

## Rollback

Remove explicit ACL entries for the constrained user:

```powershell
$Principal = "$env:COMPUTERNAME\openclaw_bot"

icacls "D:\OpenClawWorkspace" /remove "$Principal" /T /C
icacls "D:\OpenClawWorkspace" /remove:d "$Principal" /T /C
```

Remove deny entries from sibling directories if you added them:

```powershell
$Principal = "$env:COMPUTERNAME\openclaw_bot"
$Parent = "D:\"
Get-ChildItem -LiteralPath $Parent -Directory |
  Where-Object { $_.FullName -ne "D:\OpenClawWorkspace" } |
  ForEach-Object {
    icacls $_.FullName /remove:d "$Principal" /T /C
  }
```

Delete the local user if no longer needed:

```powershell
Remove-LocalUser -Name "openclaw_bot"
```

## Limitations

- This is weaker than Docker sandboxing.
- It depends on consistently running OpenClaw under the constrained user.
- If the gateway is still started by your normal user, most of the boundary is lost.
- Elevated or host-escape workflows can bypass this model.
- Some skills and tools are still more naturally supported inside Linux/WSL2.

## Related docs

- [Sandboxing](/gateway/sandboxing)
- [Windows (WSL2)](/platforms/windows)
- [Security](/gateway/security)
