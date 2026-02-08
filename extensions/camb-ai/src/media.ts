import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Get the media directory for saving Camb AI audio files
 * Uses ~/.openclaw/media/camb-ai/ by default
 */
export async function getMediaDir(): Promise<string> {
  const homeDir = os.homedir();
  const mediaDir = path.join(homeDir, ".openclaw", "media", "camb-ai");
  await fs.mkdir(mediaDir, { recursive: true });
  return mediaDir;
}

/**
 * Generate a unique filename with timestamp
 */
export function generateFilename(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

/**
 * Save audio buffer to file and return the absolute path
 */
export async function saveAudioFile(
  buffer: Buffer,
  prefix: string,
  extension: string,
): Promise<string> {
  const mediaDir = await getMediaDir();
  const filename = generateFilename(prefix, extension);
  const filePath = path.join(mediaDir, filename);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Download audio from URL and save to file
 */
export async function downloadAndSaveAudio(
  url: string,
  prefix: string,
  extension: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return saveAudioFile(buffer, prefix, extension);
}
