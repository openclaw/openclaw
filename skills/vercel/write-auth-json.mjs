import { writeFileSync } from "node:fs";

try {
  const authPath = process.env.AUTH_JSON_PATH;
  const token = process.env.TOKEN_TO_JSON;

  if (!authPath) {
    throw new Error("AUTH_JSON_PATH environment variable is required");
  }
  if (!token) {
    throw new Error("TOKEN_TO_JSON environment variable is required");
  }

  writeFileSync(authPath, JSON.stringify({ token }), { mode: 0o600 });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to write auth file: ${message}`);
  process.exit(1);
}
