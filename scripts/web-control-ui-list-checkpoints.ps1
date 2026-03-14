$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\24045\clawd\openclaw-src'

git tag --list 'checkpoint/web-control-ui-*' --sort=-creatordate | Select-Object -First 20
