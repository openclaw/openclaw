' autofix-loop-hidden.vbs
' ======================
' Thin VBScript wrapper that invokes scripts/autofix-loop.ps1 with a
' fully-hidden window via WScript.Shell.Run. Used by the scheduled task
' action (wscript.exe <this-file> <args>) so the 10-minute autofix fire
' runs silently in the background instead of briefly flashing a cmd /
' PowerShell console window every interval -- which happens even with
' `powershell -WindowStyle Hidden` because the OS creates the console
' before PS can suppress it.
'
' All command-line args passed to this VBS are forwarded verbatim to
' autofix-loop.ps1 (e.g. -Repo, -PrNumber, -DryRun).
'
' WaitOnReturn=True so the VBS exit matches the launcher's exit --
' Task Scheduler records the correct LastTaskResult.

Option Explicit

Dim fs, scriptDir, launcherPath
Set fs = CreateObject("Scripting.FileSystemObject")
scriptDir = fs.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fs.BuildPath(scriptDir, "autofix-loop.ps1")

If Not fs.FileExists(launcherPath) Then
  WScript.Echo "autofix-loop.ps1 not found at " & launcherPath
  WScript.Quit 1
End If

' Build the forwarded arg list. Each arg gets double-quoted; any
' embedded double-quotes are doubled, the standard cmd/powershell
' convention for literal quotes inside a quoted string.
Dim argList, i, rawArg
argList = ""
For i = 0 To WScript.Arguments.Count - 1
  rawArg = WScript.Arguments.Item(i)
  argList = argList & " """ & Replace(rawArg, """", """""") & """"
Next

Dim cmdLine
cmdLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
          launcherPath & """" & argList

Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")
' intWindowStyle=0 (hidden), bWaitOnReturn=True.
exitCode = shell.Run(cmdLine, 0, True)

WScript.Quit exitCode
