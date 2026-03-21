---
name: test-xcode
description: Build and test iOS apps on simulator using XcodeBuildMCP
argument-hint: "[scheme name or 'current' to use default]"
disable-model-invocation: true
---

# Xcode Test Command

<command_purpose>Build, install, and test iOS apps on the simulator using XcodeBuildMCP. Captures screenshots, logs, and verifies app behavior.</command_purpose>

## Introduction

<role>iOS QA Engineer specializing in simulator-based testing</role>

This command tests iOS/macOS apps by:
- Building for simulator
- Installing and launching the app
- Taking screenshots of key screens
- Capturing console logs for errors
- Supporting human verification for external flows

## Prerequisites

<requirements>
- Xcode installed with command-line tools
- XcodeBuildMCP server connected
- Valid Xcode project or workspace
- At least one iOS Simulator available
</requirements>

## Main Tasks

### 0. Verify XcodeBuildMCP is Installed

<check_mcp_installed>

**First, check if XcodeBuildMCP tools are available.**

Try calling:
```
mcp__xcodebuildmcp__list_simulators({})
```

**If the tool is not found or errors:**

Tell the user:
```markdown
**XcodeBuildMCP not installed**

Please install the XcodeBuildMCP server first:

\`\`\`bash
claude mcp add XcodeBuildMCP -- npx xcodebuildmcp@latest
\`\`\`

Then restart Claude Code and run `/xcode-test` again.
```

**Do NOT proceed** until XcodeBuildMCP is confirmed working.

</check_mcp_installed>

### 1. Discover Project and Scheme

<discover_project>

**Find available projects:**
```
mcp__xcodebuildmcp__discover_projs({})
```

**List schemes for the project:**
```
mcp__xcodebuildmcp__list_schemes({ project_path: "/path/to/Project.xcodeproj" })
```

**If argument provided:**
- Use the specified scheme name
- Or "current" to use the default/last-used scheme

</discover_project>

### 2. Boot Simulator

<boot_simulator>

**List available simulators:**
```
mcp__xcodebuildmcp__list_simulators({})
```

**Boot preferred simulator (iPhone 15 Pro recommended):**
```
mcp__xcodebuildmcp__boot_simulator({ simulator_id: "[uuid]" })
```

**Wait for simulator to be ready:**
Check simulator state before proceeding with installation.

</boot_simulator>

### 3. Build the App

<build_app>

**Build for iOS Simulator:**
```
mcp__xcodebuildmcp__build_ios_sim_app({
  project_path: "/path/to/Project.xcodeproj",
  scheme: "[scheme_name]"
})
```

**Handle build failures:**
- Capture build errors
- Create P1 todo for each build error
- Report to user with specific error details

**On success:**
- Note the built app path for installation
- Proceed to installation step

</build_app>

### 4. Install and Launch

<install_launch>

**Install app on simulator:**
```
mcp__xcodebuildmcp__install_app_on_simulator({
  app_path: "/path/to/built/App.app",
  simulator_id: "[uuid]"
})
```

**Launch the app:**
```
mcp__xcodebuildmcp__launch_app_on_simulator({
  bundle_id: "[app.bundle.id]",
  simulator_id: "[uuid]"
})
```

**Start capturing logs:**
```
mcp__xcodebuildmcp__capture_sim_logs({
  simulator_id: "[uuid]",
  bundle_id: "[app.bundle.id]"
})
```

</install_launch>

### 5. Test Key Screens

<test_screens>

For each key screen in the app:

**Take screenshot:**
```
mcp__xcodebuildmcp__take_screenshot({
  simulator_id: "[uuid]",
  filename: "screen-[name].png"
})
```

**Review screenshot for:**
- UI elements rendered correctly
- No error messages visible
- Expected content displayed
- Layout looks correct

**Check logs for errors:**
```
mcp__xcodebuildmcp__get_sim_logs({ simulator_id: "[uuid]" })
```

Look for:
- Crashes
- Exceptions
- Error-level log messages
- Failed network requests

</test_screens>

### 6. Human Verification (When Required)

<human_verification>

Pause for human input when testing touches:

| Flow Type | What to Ask |
|-----------|-------------|
| Sign in with Apple | "Please complete Sign in with Apple on the simulator" |
| Push notifications | "Send a test push and confirm it appears" |
| In-app purchases | "Complete a sandbox purchase" |
| Camera/Photos | "Grant permissions and verify camera works" |
| Location | "Allow location access and verify map updates" |

Use AskUserQuestion:
```markdown
**Human Verification Needed**

This test requires [flow type]. Please:
1. [Action to take on simulator]
2. [What to verify]

Did it work correctly?
1. Yes - continue testing
2. No - describe the issue
```

</human_verification>

### 7. Handle Failures

<failure_handling>

When a test fails:

1. **Document the failure:**
   - Take screenshot of error state
   - Capture console logs
   - Note reproduction steps

2. **Ask user how to proceed:**
   ```markdown
   **Test Failed: [screen/feature]**

   Issue: [description]
   Logs: [relevant error messages]

   How to proceed?
   1. Fix now - I'll help debug and fix
   2. Create todo - Add to todos/ for later
   3. Skip - Continue testing other screens
   ```

3. **If "Fix now":**
   - Investigate the issue in code
   - Propose a fix
   - Rebuild and retest

4. **If "Create todo":**
   - Create `{id}-pending-p1-xcode-{description}.md`
   - Continue testing

</failure_handling>

### 8. Test Summary

<test_summary>

After all tests complete, present summary:

```markdown
## 📱 Xcode Test Results

**Project:** [project name]
**Scheme:** [scheme name]
**Simulator:** [simulator name]

### Build: ✅ Success / ❌ Failed

### Screens Tested: [count]

| Screen | Status | Notes |
|--------|--------|-------|
| Launch | ✅ Pass | |
| Home | ✅ Pass | |
| Settings | ❌ Fail | Crash on tap |
| Profile | ⏭️ Skip | Requires login |

### Console Errors: [count]
- [List any errors found]

### Human Verifications: [count]
- Sign in with Apple: ✅ Confirmed
- Push notifications: ✅ Confirmed

### Failures: [count]
- Settings screen - crash on navigation

### Created Todos: [count]
- `006-pending-p1-xcode-settings-crash.md`

### Result: [PASS / FAIL / PARTIAL]
```

</test_summary>

### 9. Cleanup

<cleanup>

After testing:

**Stop log capture:**
```
mcp__xcodebuildmcp__stop_log_capture({ simulator_id: "[uuid]" })
```

**Optionally shut down simulator:**
```
mcp__xcodebuildmcp__shutdown_simulator({ simulator_id: "[uuid]" })
```

</cleanup>

## Quick Usage Examples

```bash
# Test with default scheme
/xcode-test

# Test specific scheme
/xcode-test MyApp-Debug

# Test after making changes
/xcode-test current
```

## Integration with /ce:review

When reviewing PRs that touch iOS code, the `/ce:review` command can spawn this as a subagent:

```
Task general-purpose("Run /xcode-test for scheme [name]. Build, install on simulator, test key screens, check for crashes.")
```
