// Keep tab attachment visually transparent: attaching the debugger must not
// leave media/theme emulation behind on the user's page.
export async function clearDebuggerAppearanceOverrides(sendCommand, debuggee) {
  try {
    await sendCommand(debuggee, 'Emulation.setEmulatedMedia', {
      media: '',
      features: [],
    })
  } catch {
    // Older Chromium builds or restricted targets may reject this.
  }

  try {
    await sendCommand(debuggee, 'Emulation.setAutoDarkModeOverride', {})
  } catch {
    // Best-effort only; unsupported on some targets.
  }
}
