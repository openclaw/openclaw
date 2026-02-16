import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let sessionInitialized = false;

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

export function __resetSupabaseForTests(): void {
  client = null;
  sessionInitialized = false;
}

export async function initSession(supabase: Pick<SupabaseClient, "auth">): Promise<void> {
  if (sessionInitialized) {
    return;
  }

  const refreshToken = readOptionalEnv("SOPHON_REFRESH_TOKEN");
  const accessToken = readOptionalEnv("SOPHON_USER_TOKEN");

  if (refreshToken) {
    const { error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!error) {
      sessionInitialized = true;
      return;
    }

    if (!accessToken) {
      throw new Error(
        `Sophon auth error: failed to refresh session. ${error.message}. ` +
          "Re-authenticate in Sophon or set SOPHON_USER_TOKEN as a fallback.",
      );
    }
  }

  if (accessToken) {
    sessionInitialized = true;
    return;
  }

  throw new Error(
    "Missing SOPHON_REFRESH_TOKEN or SOPHON_USER_TOKEN. Set one in ~/.openclaw/openclaw.json env.vars.",
  );
}

export function getSupabaseClient(): SupabaseClient {
  if (client) {
    return client;
  }

  const url = readRequiredEnv("SOPHON_SUPABASE_URL");
  const key = readRequiredEnv("SOPHON_SUPABASE_KEY");
  const accessToken = readOptionalEnv("SOPHON_USER_TOKEN");

  client = createClient(url, key, {
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
    auth: {
      persistSession: false,
      autoRefreshToken: true,
    },
  });

  return client;
}

export async function getSupabase(): Promise<SupabaseClient> {
  const supabase = getSupabaseClient();
  await initSession(supabase);
  return supabase;
}
