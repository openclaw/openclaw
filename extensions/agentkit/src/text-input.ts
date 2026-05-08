import { readFile } from "node:fs/promises";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

export async function resolveOptionalTextInputValue(params: {
  value?: string;
  file?: string;
  valueOptionLabel: string;
  fileOptionLabel: string;
  valueLabel: string;
}): Promise<string | null> {
  const inlineValue = normalizeOptionalString(params.value);
  const file = normalizeOptionalString(params.file);

  if (inlineValue && file) {
    throw new Error(
      `Pass either \`${params.valueOptionLabel}\` or \`${params.fileOptionLabel}\`, not both.`,
    );
  }

  if (!inlineValue && !file) {
    return null;
  }

  if (inlineValue) {
    return inlineValue;
  }

  const raw = file === "-" ? await readStdin() : await readFile(file as string, "utf8");
  const resolvedValue = normalizeOptionalString(raw);
  if (!resolvedValue) {
    throw new Error(`The supplied ${params.valueLabel} source was empty.`);
  }
  return resolvedValue;
}
