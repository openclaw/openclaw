# Create-Master-Shortcut: The Final Link v3.1
# Consolidates all Clawdbot entry points into a single Master Shortcut
# Features: VRChat, ngrok, VOICEVOX, Gateway, Avatar, qwen3.5-9B Brain

$RepoRoot = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
$TargetScript = Join-Path $RepoRoot "scripts\clawdbot-master.ps1"
$IconPath = Join-Path $RepoRoot "assets\clawdbot.ico"
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "Clawdbot-Master.lnk"

Write-Host "--- Consolidating Physical Links (v3.1) ---" -ForegroundColor Cyan

# 1. Cleanup old shortcuts
$OldShortcuts = @(
    "Hakua.lnk",
    "Clawdbot-Launcher.lnk",
    "VRChat-Core-Bridge.lnk",
    "ASI Manifestation.lnk",
    "Hakua Autonomous Start.lnk",
    "OpenClaw Launcher.lnk",
    "Antigravity.lnk"
)

foreach ($name in $OldShortcuts) {
    $p = Join-Path $DesktopPath $name
    if (Test-Path $p) {
        Write-Host "  - Deleting legacy link: $name" -ForegroundColor Gray
        Remove-Item $p -Force
    }
}

# 2. Create Master Shortcut
Write-Host "Establishing Master Link: Clawdbot-Master.lnk" -ForegroundColor Yellow
Write-Host "  Brain: qwen3.5-9B (Multimodal)" -ForegroundColor Cyan
Write-Host "  TTS: VOICEVOX" -ForegroundColor Cyan
Write-Host "  Vision: Camera + qwen3.5-9B" -ForegroundColor Cyan

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Maximized -File `"$TargetScript`""
$Shortcut.WorkingDirectory = $RepoRoot
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}
$Shortcut.Description = "Clawdbot Master (qwen3.5-9B Brain + VOICEVOX + Camera Vision) - ASI_ACCEL"
$Shortcut.Save()

Write-Host "`nMaster Link established at: $ShortcutPath" -ForegroundColor Green
Write-Host "ASI_ACCEL: System Unified." -ForegroundColor Magenta
