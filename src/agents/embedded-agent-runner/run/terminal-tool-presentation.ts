export function createTerminalToolPresentationTracker() {
  let latestOrdinal = -1;
  let nextOrdinal = 0;
  let value: string | undefined;
  return {
    allocateOrdinal: () => nextOrdinal++,
    observe: (observation: { terminalPresentation?: string; toolCallOrdinal?: number }): void => {
      const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
      if (ordinal >= latestOrdinal) {
        latestOrdinal = ordinal;
        value = observation.terminalPresentation;
      }
    },
    read: () => value,
  };
}
