import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";

export async function renderQrCodeInTerminal(input: string): Promise<void> {
  const output = await renderQrTerminal(input, { small: true });
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export async function renderQrCodeToString(input: string): Promise<string> {
  const output = await renderQrTerminal(input, { small: true });
  return output.trimEnd();
}
