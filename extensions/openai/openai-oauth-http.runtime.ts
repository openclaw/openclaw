import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export async function withOpenAIOAuthResponse<T>(
  request: Parameters<typeof fetchWithSsrFGuard>[0],
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard(request);
  try {
    // Keep the guarded transport alive through bounded reads and owner validation.
    return await consume(response);
  } finally {
    await release();
  }
}

export function createOpenAIAuthorizationCodeForm(params: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
}): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
    ...(params.resource ? { resource: params.resource } : {}),
  });
}
