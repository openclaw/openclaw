# Build Your First Extension (Skill)

This guide walk you through creating a simple **System Dashboard** skill for Clawdbot on Windows. Skills are located in the `extensions/` directory and can use PowerShell commands to interact with your system.

## Step 1: Create the Skill Directory
First, create a folder for your new skill within the `extensions` directory.

```powershell
# Navigate to your clawdbot folder
cd ~\Desktop\clawdbot\clawdbot

# Create the folder for your new skill
mkdir extensions\system-stats
```

## Step 2: Create the Skill File
Create a new file named `SKILL.md` inside `extensions\system-stats\` and paste the Following content:

```markdown
---
name: system-status
description: Reports current CPU, Memory, and Disk usage on Windows.
---
# Procedure
1. Run the PowerShell command: `Get-CimInstance Win32_OperatingSystem | Select-Object @{Name='FreeGB';Expression={[math]::round($_.FreePhysicalMemory/1MB,2)}}, @{Name='TotalGB';Expression={[math]::round($_.TotalVisibleMemorySize/1MB,2)}}`
2. Run the PowerShell command: `Get-CimInstance Win32_Processor | Select-Object LoadPercentage`
3. Run the PowerShell command: `Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq 'C:' } | Select-Object @{Name='FreeGB';Expression={[math]::round($_.FreeSpace/1GB,2)}}, @{Name='TotalGB';Expression={[math]::round($_.Size/1GB,2)}}`
4. Display a clean summary table showing:
   - **CPU Usage:** [LoadPercentage]%
   - **Memory:** [UsedGB] / [TotalGB] GB
   - **Disk (C:):** [FreeGB] GB Free of [TotalGB] GB
5. If CPU > 80% or Memory < 1GB, add a warning: "⚠️ System is under heavy load!"
```

## Step 3: Run and Test
Start the "Dev" mode of the bot to load your new extension:

```powershell
pnpm gateway:watch
```

Once it's running, talk to Clawdbot and say:
- "system-status"
- "Run system stats"

Clawdbot will execute the PowerShell commands and display your computer's live stats! 🦞🎉
