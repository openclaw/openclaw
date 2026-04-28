import { httpJson } from "./util.js";
import type { SupabaseProject } from "./types.js";

const API_BASE = "https://api.supabase.com";

export class SupabaseAuthError extends Error {
  constructor(msg: string, public status: number) {
    super(msg);
    this.name = "SupabaseAuthError";
  }
}

export async function listProjects(token: string): Promise<SupabaseProject[]> {
  const res = await httpJson<unknown>(`${API_BASE}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SupabaseAuthError(
      `Auth failed (${res.status}): ${res.text.slice(0, 200)}`,
      res.status
    );
  }
  if (!res.ok) {
    throw new Error(
      `List projects failed (${res.status}): ${
        res.error ?? res.text.slice(0, 200)
      }`
    );
  }
  if (!Array.isArray(res.body)) {
    throw new Error(
      `Unexpected projects response shape: ${res.text.slice(0, 200)}`
    );
  }
  const projects: SupabaseProject[] = [];
  for (const raw of res.body as Record<string, unknown>[]) {
    const ref = (raw.ref ?? raw.id) as string | undefined;
    const id = (raw.id ?? raw.ref) as string | undefined;
    const name = raw.name as string | undefined;
    if (!ref || !id || !name) continue;
    projects.push({
      id,
      ref,
      name,
      organization_id: raw.organization_id as string | undefined,
      region: raw.region as string | undefined,
      status: raw.status as string | undefined,
    });
  }
  return projects;
}
