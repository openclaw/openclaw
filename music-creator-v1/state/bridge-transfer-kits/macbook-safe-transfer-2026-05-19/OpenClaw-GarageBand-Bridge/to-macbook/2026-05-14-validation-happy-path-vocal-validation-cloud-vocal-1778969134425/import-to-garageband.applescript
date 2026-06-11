on run argv
  if (count of argv) is 0 then error "Missing audio file"
  set audioPath to item 1 of argv

  try
    tell application "GarageBand" to activate
  on error errMsg
    display dialog "GarageBand is not installed or could not be opened. Install GarageBand from the Mac App Store, then run this helper again." buttons {"OK"} default button "OK"
    error errMsg
  end try

  delay 1

  tell application "Finder"
    reveal POSIX file audioPath
    activate
  end tell

  display dialog "Bridge job 2026-05-14-validation-happy-path-vocal-validation-cloud-vocal-1778969134425 is ready. GarageBand is open and Finder is showing the audio file. Drag the file into a GarageBand track, edit/arrange, then bounce or export the finished audio into this job's from-macbook folder." buttons {"Done"} default button "Done"
end run
