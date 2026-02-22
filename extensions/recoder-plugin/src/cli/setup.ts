/**
 * Recoder Setup CLI Command
 *
 * Interactive wizard for configuring Recoder credentials.
 * Usage: openclaw recoder:setup
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as readline from "node:readline";

const CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw", "credentials");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "recoder.json");

export interface RecoderCredentials {
  webUrl: string;
  dockerUrl: string;
  apiUrl: string;
  apiKey?: string;
  sessionCookie?: string;
  configuredAt: number;
}

/**
 * Prompt user for input
 */
function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const displayQuestion = defaultValue
    ? `${question} (${defaultValue}): `
    : `${question}: `;

  return new Promise((resolve) => {
    rl.question(displayQuestion, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/**
 * Load existing credentials
 */
export async function loadCredentials(): Promise<RecoderCredentials | null> {
  try {
    const content = await fs.readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content) as RecoderCredentials;
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk
 */
export async function saveCredentials(creds: RecoderCredentials): Promise<void> {
  await fs.mkdir(CREDENTIALS_DIR, { recursive: true });
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), "utf-8");
}

/**
 * Run the setup wizard
 */
export async function runSetupWizard(): Promise<void> {
  console.log("\n🔧 Recoder.xyz Setup Wizard\n");
  console.log("This wizard will configure your Recoder credentials.\n");

  const existing = await loadCredentials();
  if (existing) {
    console.log("Existing configuration found:");
    console.log(`  Web URL: ${existing.webUrl}`);
    console.log(`  Docker URL: ${existing.dockerUrl}`);
    console.log(`  API URL: ${existing.apiUrl}`);
    console.log(`  API Key: ${existing.apiKey ? "****" + existing.apiKey.slice(-4) : "(not set)"}`);
    console.log("");
  }

  // Web URL
  const webUrl = await prompt(
    "Recoder web URL",
    existing?.webUrl || "https://web.recoder.xyz",
  );

  // Docker URL
  const dockerUrl = await prompt(
    "Docker backend URL",
    existing?.dockerUrl || "https://docker.recoder.xyz",
  );

  // API URL
  const apiUrl = await prompt(
    "Recoder API URL",
    existing?.apiUrl || "https://api.recoder.xyz",
  );

  // API Key
  console.log("\nAPI Key is required for all operations.");
  console.log("A unique key will be auto-generated for your OpenClaw account.");
  console.log("Or get one manually from: https://web.recoder.xyz/settings/api-keys\n");

  const apiKey = await prompt(
    "API Key (sk_xxx_xxx, leave blank to auto-generate)",
    existing?.apiKey || "",
  );

  // Validate API key format if provided
  if (apiKey && !apiKey.startsWith("sk_")) {
    console.log("\n⚠️  Warning: API key doesn't match expected format (sk_xxx_xxx)");
  }

  // Save credentials
  const creds: RecoderCredentials = {
    webUrl,
    dockerUrl,
    apiUrl,
    apiKey: apiKey || undefined,
    configuredAt: Date.now(),
  };

  await saveCredentials(creds);

  console.log("\n✅ Configuration saved to ~/.openclaw/credentials/recoder.json");

  if (!apiKey) {
    console.log("\n📝 Note: API key will be auto-generated when you first use Recoder tools.");
    console.log("   Each OpenClaw user gets a unique key stored in Recoder's database.");
  }

  console.log("\nYou can now use Recoder tools in your OpenClaw agents!");
  console.log("\nExample prompts:");
  console.log('  "Build me a todo app"');
  console.log('  "Create a React dashboard"');
  console.log('  "Make a landing page for my startup"\n');
}

/**
 * Verify credentials are valid
 */
export async function verifyCredentials(creds: RecoderCredentials): Promise<{
  valid: boolean;
  webOk: boolean;
  dockerOk: boolean;
  apiOk: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let webOk = false;
  let dockerOk = false;
  let apiOk = false;

  const headers = creds.apiKey
    ? { "X-API-Key": creds.apiKey, Authorization: `Bearer ${creds.apiKey}` }
    : {};

  // Check Recoder web
  try {
    const response = await fetch(`${creds.webUrl}/api/system-health`, {
      method: "GET",
      headers,
    });
    webOk = response.ok;
    if (!response.ok) {
      errors.push(`Recoder web returned ${response.status}`);
    }
  } catch (err) {
    errors.push(`Failed to connect to Recoder web: ${err}`);
  }

  // Check Docker backend
  try {
    const response = await fetch(`${creds.dockerUrl}/health`, {
      method: "GET",
      headers,
    });
    dockerOk = response.ok;
    if (!response.ok) {
      errors.push(`Docker backend returned ${response.status}`);
    }
  } catch (err) {
    errors.push(`Failed to connect to Docker backend: ${err}`);
  }

  // Check API backend
  try {
    const response = await fetch(`${creds.apiUrl}/health`, {
      method: "GET",
      headers,
    });
    apiOk = response.ok;
    if (!response.ok) {
      errors.push(`API backend returned ${response.status}`);
    }
  } catch (err) {
    errors.push(`Failed to connect to API backend: ${err}`);
  }

  return {
    valid: webOk && dockerOk && apiOk,
    webOk,
    dockerOk,
    apiOk,
    errors,
  };
}
