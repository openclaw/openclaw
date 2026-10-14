import fs from "node:fs";

export function readBoundedArtifactText(file: string, maxBytes: number, label: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${file}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${file} (${stat.size} bytes)`);
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${file} (${bytes} bytes)`);
  }
  return text;
}
