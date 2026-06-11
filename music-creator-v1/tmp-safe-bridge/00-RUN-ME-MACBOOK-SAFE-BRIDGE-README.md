# MacBook Safe Bridge: Run This First

Use this on the MacBook only.

1. Keep Remote Login off: System Settings > General > Sharing > Remote Login.
2. Right-click `00-RUN-ME-MACBOOK-SAFE-BRIDGE.command`.
3. Choose Open.
4. Let it finish.
5. Go back to the Mac Studio and run bridge status.

What it does:

- Verifies the bridge sync probe.
- Writes the MacBook reply back into the bridge folder.
- Processes exactly one signed OpenClaw bridge request.
- Does not use SSH or Remote Login.
- Does not allow arbitrary shell commands.
- Does not read outside this bridge folder except for basic GarageBand/status checks.
