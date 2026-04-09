import readline from "node:readline/promises";

export type PermissionPromptOptions = {
  prompt: string;
  header?: string;
  details?: string;
};

export async function promptForPermission(options: PermissionPromptOptions): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }

  if (options.header) {
    process.stderr.write(`\n${options.header}\n`);
  }
  if (options.details && options.details.trim().length > 0) {
    process.stderr.write(`${options.details}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await rl.question(options.prompt);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
