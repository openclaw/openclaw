on run argv
  if (count of argv) is less than 2 then error "E_TASK_INVALID: expected <inputPath> <pngPath>"

  set inputPath to item 1 of argv
  set pngPath to item 2 of argv
  set jsSource to read (POSIX file "skills/psd-automator/scripts/psd-export-png-mac.jsx")
  set jsSource to my replaceText(jsSource, "__INPUT_PATH__", my jsEscape(inputPath))
  set jsSource to my replaceText(jsSource, "__PNG_PATH__", my jsEscape(pngPath))

  using terms from application id "com.adobe.Photoshop"
    tell application id "com.adobe.Photoshop"
      do javascript jsSource
    end tell
  end using terms from

  return "{\"status\":\"ok\",\"code\":\"OK\"}"
end run

on jsEscape(inputText)
  set bs to ASCII character 92
  set escaped to my replaceText(inputText, bs, bs & bs)
  set escaped to my replaceText(escaped, quote, bs & quote)
  set escaped to my replaceText(escaped, return, bs & "n")
  set escaped to my replaceText(escaped, linefeed, bs & "n")
  return escaped
end jsEscape

on replaceText(inputText, findText, replaceWith)
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set textItems to every text item of inputText
  set AppleScript's text item delimiters to replaceWith
  set outputText to textItems as text
  set AppleScript's text item delimiters to oldDelims
  return outputText
end replaceText
