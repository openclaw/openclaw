on run argv
  if (count of argv) is less than 4 then error "E_TASK_INVALID: expected <inputPath> <layerName> <newText> <outputPath>"

  set inputPath to item 1 of argv
  set targetLayerName to item 2 of argv
  set newText to item 3 of argv
  set outputPath to item 4 of argv
  set jsSource to read (POSIX file "skills/psd-automator/scripts/psd-modify-mac.jsx")
  set jsSource to my replaceText(jsSource, "__INPUT_PATH__", my jsEscape(inputPath))
  set jsSource to my replaceText(jsSource, "__LAYER_NAME__", my jsEscape(targetLayerName))
  set jsSource to my replaceText(jsSource, "__NEW_TEXT__", my jsEscape(newText))
  set jsSource to my replaceText(jsSource, "__OUTPUT_PATH__", my jsEscape(outputPath))

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
