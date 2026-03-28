const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LEGACY_DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export interface ResolveMcpWorkspaceIdOptions {
  explicitWorkspaceId?: unknown;
  configuredWorkspaceId?: unknown;
  hqBaseUrl: string;
  apiSecret?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function normalizeWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function buildWorkspaceContextHeaders(apiSecret?: string): Record<string, string> {
  if (!apiSecret) {
    return {};
  }
  return { Authorization: `Bearer ${apiSecret}` };
}

async function readWorkspaceContextPayload(response: Response): Promise<{
  payload: {
    ok?: boolean;
    workspace_id?: unknown;
    error?: string;
    code?: string;
  } | null;
  rawBody: string | null;
}> {
  if (typeof response.text === "function") {
    const rawBody = await response.text();
    try {
      return {
        payload: JSON.parse(rawBody) as {
          ok?: boolean;
          workspace_id?: unknown;
          error?: string;
          code?: string;
        },
        rawBody,
      };
    } catch {
      return { payload: null, rawBody };
    }
  }

  if (typeof response.json === "function") {
    return {
      payload: (await response.json()) as {
        ok?: boolean;
        workspace_id?: unknown;
        error?: string;
        code?: string;
      },
      rawBody: null,
    };
  }

  return { payload: null, rawBody: null };
}

function getConfiguredWorkspaceId(configuredWorkspaceId?: unknown): string | undefined {
  const explicit = normalizeWorkspaceId(configuredWorkspaceId);
  if (explicit && explicit !== LEGACY_DEFAULT_WORKSPACE_ID) {
    return explicit;
  }

  const fromEnv = normalizeWorkspaceId(process.env.AIRYA_WORKSPACE_ID);
  if (fromEnv && fromEnv !== LEGACY_DEFAULT_WORKSPACE_ID) {
    return fromEnv;
  }

  return undefined;
}

export async function resolveMcpWorkspaceId(
  options: ResolveMcpWorkspaceIdOptions,
): Promise<string> {
  const explicitWorkspaceId = normalizeWorkspaceId(options.explicitWorkspaceId);
  if (explicitWorkspaceId) {
    return explicitWorkspaceId;
  }

  const configuredWorkspaceId = getConfiguredWorkspaceId(options.configuredWorkspaceId);
  if (configuredWorkspaceId) {
    return configuredWorkspaceId;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const response = await fetchFn(`${options.hqBaseUrl}/api/airya/workspace-context`, {
    method: "GET",
    headers: buildWorkspaceContextHeaders(options.apiSecret),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { payload } = await readWorkspaceContextPayload(response);

  // Older/stale HQ runtimes may not expose the dedicated workspace-context route
  // even though /api/airya/tool is live. In local nil-workspace mode, the safe
  // compatibility fallback is the legacy default workspace id.
  if (response.status === 404) {
    return LEGACY_DEFAULT_WORKSPACE_ID;
  }

  if (!payload) {
    throw new Error(
      `Workspace context request returned a non-JSON response with status ${response.status}.`,
    );
  }

  if (!response.ok || payload.ok !== true) {
    throw new Error(
      payload.error ??
        `Workspace context request failed with status ${response.status} (${payload.code ?? "UNKNOWN"})`,
    );
  }

  const workspaceId = normalizeWorkspaceId(payload.workspace_id);
  if (!workspaceId) {
    throw new Error("Workspace resolver returned an invalid workspace_id.");
  }

  return workspaceId;
}
