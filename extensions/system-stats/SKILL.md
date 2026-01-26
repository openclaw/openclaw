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
