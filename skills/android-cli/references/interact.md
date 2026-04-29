# Tools
Run `android layout --help` and `android screen --help`.

## UI Dump
`android layout`  returns a flat JSON list of the UI elements on screen.
`android layout --diff` returns a flat JSON list of the UI elements that have changed since the last call to `layout` or `layout --diff`

Each JSON object represents a UI element in the Android app. The following properties may be present:
- `text` - any literal text the element contains
- `resourceId` - the Android resource id used to refer to the element
- `contentDesc` - a description of a UI element for use by accessibility tools
- `interactions` - the set of user interactions the element supports. May contain one or more of: `checkable`, `clickable`, `focusable`, `scrollable`, `long-clickable`, `password`
- `state` - the set of states the element is in. May contain one or more of `checked`, `focused`, `selected`
- `bounds` - the screen coordinates of the bounding rectangle of the element, in the format `[min X,min Y][max X, max Y]`
- `center` - the screen coordinates of the center of the element, in the format `[x,y]`
- `off-screen` - if true, the element is in the UI hierarchy but not visible; it may require scrolling to view.

Use `layout` as a primary means of examining an Android app. Use `layout --diff` to focus on changes and to keep your context small.
Example: When entering digits into a calculator, use `layout --diff` to output only the digit readout element.

`layout` may fail due to the app displaying a WebView or animation; in these cases, use `android screen --annotate` to inspect the app.
This failure will likely resolve after navigating away from the current screen.

## Screenshot
`android screen capture -o <file path>` saves a PNG of the current device screen to `<file path>`

Use `screen capture` as a secondary means of examining an Android app
Examples:
- Understanding the content of an on-screen image
- Looking at a `WebView` (web content does not always appear in the ui dump)
- Trying to find a UI element by its visual appearance

**IMPORTANT**: Always *VISUALLY* examine the PNG image returned from `android screen` BEFORE doing anything else.

## Annotated Screenshot
`android screen capture --annotate -o <file path>`
`android screen resolve --screen <path> --string <string>`

The `--annotate` command adds numerical labels and bounding boxes around UI elements. Use this command to locate UI elements that cannot
be located in the `layout` output.

**IMPORTANT**: When using `android screen --annotate`, always *VISUALLY* examine the resulting PNG file.

To refer to these labels in input commands, use `screen resolve` to convert labels into coordinates:

`android screen resolve --screen <file path> --string "#3"` returns `<x coord of region 3> <y coord of region 3>`

To save turns, you can combine shell commands:

`adb shell input $(android screen resolve --screen screen.png --string "tap #34")`

This command taps on region #34 from `screen.png`

## Input
Use `adb shell input` for interacting with Android devices.
Refer to the `"interactions"` property of an element for what interactions can be performed on a particular element.

Interact with UI elements with their `center` coordinate or their `bounds` coordinates:
```json
{
  "key": -248568265,
  "class": "android.widget.Button",
  "bounds": "[138,9][167,38]",
  "center": "[152,23]"
}
```
To tap on this button, you would execute `adb shell input tap 152 23`. This taps the center.

```json
{
  "key": 12487234,
  "class": "com.example.ui.ScrollableList",
  "bounds": "[100,200][400,600]",
  "center": "[250,400]"
}
```
To scroll down on this list, you would execute `adb shell input swipe 250 400 600 500`. This swipes from the center to the bottom over 500ms.

# Android Interaction Rules
1. Always ensure text input fields have `"focused"` in their `"state"` list before entering text
2. If an element has `"scrollable"` in its `"interactions"` list, try scrolling it when looking for missing UI elements
2. Always scroll slowly when executing scroll inputs. The 5th argument to `adb shell input swipe` controls scroll duration.
3. Content may take time to load; if a `layout` is missing information after you take an action, wait a few seconds, then perform `layout --diff` to see if anything changes.