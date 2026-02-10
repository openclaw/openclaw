---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: eightctl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Control Eight Sleep pods (status, temperature, alarms, schedules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://eightctl.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🎛️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["eightctl"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/eightctl/cmd/eightctl@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["eightctl"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install eightctl (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# eightctl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `eightctl` for Eight Sleep pod control. Requires auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `~/.config/eightctl/config.yaml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Env: `EIGHTCTL_EMAIL`, `EIGHTCTL_PASSWORD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `eightctl status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `eightctl on|off`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `eightctl temp 20`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Alarms: `eightctl alarm list|create|dismiss`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Schedules: `eightctl schedule list|create|update`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audio: `eightctl audio state|play|pause`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base: `eightctl base info|angle`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API is unofficial and rate-limited; avoid repeated logins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm before changing temperature or alarms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
