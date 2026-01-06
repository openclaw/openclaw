# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## SSH Hosts

### synology
- **IP**: 192.168.4.84
- **User**: dbhurley
- **Port**: 22
- **Services**: Plex, Radarr, Sonarr, SABnzbd, Home Assistant
- **Use**: `ssh synology`

### mac-mini (Coming Jan 13-15)
- **IP**: TBD
- **User**: dbhurley
- **Services**: Future "brain" - will host migrated services
- **Use**: `ssh mac-mini`

## Smart Home

### Hue Bridge
- **IP**: 192.168.4.95
- **Status**: Connection issues as of Jan 4, 2026
- **Rooms**: Master Suite (need to map lights)

## Media Server (Synology)

- **Plex**: http://192.168.4.84:32400
- **Radarr**: http://192.168.4.84:7878
- **Sonarr**: http://192.168.4.84:8989
- **SABnzbd**: http://192.168.4.84:8080

## Package Managers

**Use pnpm for global packages** (it's first in PATH):
```bash
pnpm add -g <package>    # ✅ correct
npm install -g <package>  # ❌ goes to wrong location
```

Global bins: `/Users/dbhurley/Library/pnpm/`

---

Add whatever helps you do your job. This is your cheat sheet.
