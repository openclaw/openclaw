# .aoa - aOa Project Link

This folder links this project to your global aOa installation.

## Files

| File | Purpose |
|------|---------|
| `home.json` | Points to global aOa install location |
| `whitelist.txt` | Optional: extra URLs/repos for this project |

## What is aOa?

aOa (Angle of Attack) provides fast O(1) code search for Claude Code.
It replaces slow Grep/Glob operations with indexed symbol lookup.

## Commands

```bash
aoa search <term>    # Search this project
aoa health           # Check services
aoa remove           # Remove aOa from this project
```

## Global Settings

To change aOa settings (port, confidence threshold, etc.),
edit the config.json in your global aOa installation.
