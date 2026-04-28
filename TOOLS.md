# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

### Isaac Live Bridge

- Isaac Sim Windows native streaming bridge:
  `python3 /home/mertb/isaac-live-control/send_command.py`
- Native wrapper command:
  `isaac-live`
- Shared queue dir:
  `/mnt/c/Users/mertb/AppData/Local/IsaacLiveBridge`
- Useful commands:
  `isaac-live state`
  `isaac-live ping`
  `isaac-live scene-status`
  `isaac-live mission-status`
  `isaac-live demo-setup`
  `isaac-live spawn-drone-marker --name primary --at 0 0 1.0`
  `isaac-live set-home --at 0 0 0.5`
  `isaac-live goto-waypoint --name wp1 --at 2 0 1.0`
  `isaac-live start-patrol --points "0,0,1;2,0,1;2,2,1"`
  `isaac-live spawn-target --name alpha --at 2 0 1.5`
  `isaac-live move-target --name alpha --to 3 1 1.5`
  `isaac-live delete-target --name alpha`
  `isaac-live scene-reset`
  `isaac-live list-prims --limit 20`
  `isaac-live create-cube --path /World/OpenClawCube --size 0.5 --translate 0 0 1`
  `isaac-live set-translate --path /World/OpenClawCube --translate 2 0 1.5`
  `isaac-live delete-prim --path /World/OpenClawCube`

### Windows Host Access

- `powershell.exe` is reachable from WSL
- `pwsh` wrapper:
  `/home/mertb/.local/bin/pwsh`
  Windows host currently has real PowerShell 7 installed at:
  `/mnt/c/Program Files/PowerShell/7/pwsh.exe`
- `dotnet` wrapper:
  `/home/mertb/.local/bin/dotnet`
- Browser launch wrapper:
  `/home/mertb/.local/bin/browser-launch`
- Windows filesystem:
  `/mnt/c`, `/mnt/d`, `/mnt/e`
- Example commands:
  `powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`
  `pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`
  `dotnet --info`
  `browser-launch https://example.com`
  `python3 /home/mertb/isaac-live-control/send_command.py state`
  `python3 /home/mertb/isaac-live-control/send_command.py ping`
  `python3 /home/mertb/isaac-live-control/send_command.py list-prims --limit 20`
  `python3 /home/mertb/isaac-live-control/send_command.py create-cube --path /World/OpenClawCube --size 0.5 --translate 0 0 1`
  `python3 /home/mertb/isaac-live-control/send_command.py set-translate --path /World/OpenClawCube --translate 2 0 1.5`
  `python3 /home/mertb/isaac-live-control/send_command.py delete-prim --path /World/OpenClawCube`
