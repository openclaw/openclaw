A journey is an XML-specified test of an Android app's behavior. It consists of a list of `<action>` elements. For example:
```xml
<journey name="My Journey">
   <description>
      A sample journey to illustrate the format
   </description>
   <actions>
     <action>
       Tap the "Home" icon
     </action>
     <action>
       Verify that the app is on its Home screen
     </action>
   </actions>
</journey>
```

Evaluate a journey by proceeding through the `<actions>` list in sequential order. Evaluate each `<action>` block individually.
A journey succeeds if all elements in the `<actions>` list succeed.

A journey is a test case for an app. The journey XML is the source of truth; if the app disagrees with the journey, the app has failed.
Additionally, if the app exits, crashes, or freezes, journey evaluation stops and the journey fails.

**IMPORTANT** - Execute each step EXACTLY as written, and independently of other steps! If an action says to `"tap the first search result"`,
you MUST find the search results and tap the first one. Do this even if you believe you know the intent behind the action.

## Taking Actions
Some `<action>` elements specify UI interactions to perform on the running Android app. Perform the interaction and verify that the app does 
not crash or behave in an unexpected manner. This is the *only* verification you should perform for an `<action>`.

If the interaction cannot be performed as specified, the journey fails. 
Example: 
```<action>Click the red button</action>```
If you determine a red button is not present in the UI, the journey fails. 

If the text of an `<action>` specifies a list of actions, break it into sub-actions and evaluate them individually: 
Example:
```<action>Search for soda and add the first result to the cart</action>```
This should be evaluated as:
```
<action>Search for soda</action>
<action>Add the first result to the cart</action>
```

If an `<action>` contains something that is not a specification for a UI interaction, alert the user that the journey is malformed and exit
early, specifying the error in question.

## Verifying Expectations
`<action>` elements that begin with "check" or "verify" specify expectations for the current state of the Android app. Determine the current
state of the app and check if the expectations are met.

Determine the current state of the app by inspecting the current screen of the device without interacting with it.
Example:
```<action>Check if "Switch 2" is visible on the screen</action>```
This requires only inspecting the current screen, not scrolling or interacting. If "Switch 2" is not currently visible, the action fails.

If the expectations are not met, mark the `<action>` as a failure and the journey evaluation ends. A single `<action>` may contain
multiple expectations.
Example:
```<action>Verify that the app is on the Home screen, the Home icon is blue, and the temperature is displayed</action>```
This `<action>` fails if ANY of the following are false:
- The app is on the Home screen
- There is a Home icon, and it is blue
- A temperature is displayed

## Handling failure 
When running a journey, evaluate it as a test. Failure is acceptable, and often expected. Proper reporting of failures is the priority.

Keep debugging and troubleshooting to a minimum; assume that tools are showing you the correct output every time. The goal is to determine 
if the *current* Android app can correctly handle the *current* steps outlined in the journey. Suggestions for bug fixes, clarification, or 
other improvements should be kept to journey evaluation summary at the end.

## Summarizing
For each `<action>` you evaluated, output JSON describing the results.

```
{
  "journey:", The name of the journey
  "results:" [
    {
      // A string containing the full text of the <action> 
      "action": "Click the blue button,
      // "PASSED" if the instruction was evaluated, "FAILED" if the instruction could not be evaluated, or "SKIPPED" if journey evaluation ended early because an instruction failed 
      "status": "PASSED", 
      // A list of the ADB commands executed while evaluating the instruction,
      "commands": [ "adb input swipe 490 200 500 500 500", "adb input tap 45 920" ],  
      // Failure reasons, feedback, or other useful information 
      "comment": "The journey step doesn't specify that the button requires scrolling to see", 
    },
    {
      "action": "The home screen is shown", 
      "status": "FAILED", 
      "comment": "The settings page was shown",   
    },
  ]
}
```
