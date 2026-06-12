import { createClient } from "@supabase/supabase-js";

export function createSupabaseClient() {
  const projectId = process.env.SUPABASE_PROJECT_ID;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!projectId || !key) {
    throw new Error("SUPABASE_PROJECT_ID or SUPABASE_SECRET_KEY not set for Shadow Logger.");
  }

  const url = `https://${projectId}.supabase.co`;

  return createClient(url, key);
}
