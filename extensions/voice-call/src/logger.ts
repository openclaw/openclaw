type VoiceCallLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

function writeLine(stream: NodeJS.WriteStream, message: string): void {
  stream.write(`${message}\n`);
}

export function formatVoiceCallError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export const voiceCallLogger: VoiceCallLogger = {
  info: (message) => writeLine(process.stdout, message),
  warn: (message) => writeLine(process.stderr, message),
  error: (message) => writeLine(process.stderr, message),
  debug: (message) => writeLine(process.stdout, message),
};
