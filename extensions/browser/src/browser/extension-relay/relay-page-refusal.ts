export function isPermanentChromePageRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    "The extensions gallery cannot be scripted.",
    "Cannot access a chrome:// URL",
    "Cannot access a chrome-extension:// URL of different extension",
  ].some(
    (reason) =>
      error.message === reason ||
      // Store extensions stringify the acquisition cause when native cleanup
      // also fails. Keep that cleanup debt, but do not let its envelope hide
      // Chrome's refusal from discovery. A refusal only in cleanup is not enough.
      error.message.startsWith(
        `Debugger acquisition failed: Error: ${reason}; cleanup incomplete: `,
      ) ||
      error.message === `Debugger cleanup incomplete: Error: ${reason}`,
  );
}
