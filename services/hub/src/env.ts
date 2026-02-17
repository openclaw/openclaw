export type Env = {
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN: string;
  SLACK_OAUTH_REDIRECT_URI: string;
  ADMIN_PASSWORD: string;
  OPENCLAW_IMAGE: string;
  PORT: number;
  STATE_SECRET: string;
  DB_PATH: string;
};

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

export async function loadEnv(): Promise<Env> {
  const { randomBytes } = await import("node:crypto");

  return {
    SLACK_CLIENT_ID: requireEnv("SLACK_CLIENT_ID"),
    SLACK_CLIENT_SECRET: requireEnv("SLACK_CLIENT_SECRET"),
    SLACK_SIGNING_SECRET: requireEnv("SLACK_SIGNING_SECRET"),
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN || "",
    SLACK_OAUTH_REDIRECT_URI: requireEnv("SLACK_OAUTH_REDIRECT_URI"),
    ADMIN_PASSWORD: requireEnv("ADMIN_PASSWORD"),
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || "openclaw:local",
    PORT: parseInt(process.env.PORT || "9876", 10),
    STATE_SECRET: process.env.STATE_SECRET || randomBytes(32).toString("hex"),
    DB_PATH: process.env.DB_PATH || "./data/hub.db",
  };
}
