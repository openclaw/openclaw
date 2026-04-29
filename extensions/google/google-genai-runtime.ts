import { GoogleGenAI } from "@google/genai";
import {
  getAuthorizedUserAccessToken,
  loadAdcCredentials,
  type AdcCredentials,
} from "./adc-credentials.js";

export type GoogleGenAIClient = InstanceType<typeof GoogleGenAI>;
export type GoogleGenAIOptions = ConstructorParameters<typeof GoogleGenAI>[0];

export function createGoogleGenAI(options: GoogleGenAIOptions): GoogleGenAIClient {
  return new GoogleGenAI(options);
}

export type CreateVertexClientDeps = {
  loadCredentials?: (path: string) => Promise<AdcCredentials>;
  mintToken?: (cred: Extract<AdcCredentials, { type: "authorized_user" }>) => Promise<string>;
  env?: NodeJS.ProcessEnv;
};

/**
 * Build a Vertex-mode GoogleGenAI client that tolerates `authorized_user` ADC.
 *
 * The bundled `@google/genai` SDK only handles `service_account` ADC cleanly; an
 * `authorized_user` ADC file (the default for `gcloud auth application-default
 * login`) makes the SDK throw `TypeError: Cannot convert undefined or null to
 * object` because it iterates fields that only exist on service-account creds.
 *
 * For `authorized_user`, exchange the refresh token at the OAuth2 token endpoint
 * and inject the resulting Bearer token via `httpOptions.headers.Authorization`,
 * bypassing the SDK's own credential resolver.
 */
export async function createGoogleVertexGenAI(
  options: GoogleGenAIOptions & { vertexai: true; project?: string; location?: string },
  deps: CreateVertexClientDeps = {},
): Promise<GoogleGenAIClient> {
  const env = deps.env ?? process.env;
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!credPath) {
    return new GoogleGenAI(options);
  }
  const load = deps.loadCredentials ?? loadAdcCredentials;
  const cred = await load(credPath);
  if (cred.type !== "authorized_user") {
    return new GoogleGenAI(options);
  }

  const project =
    options.project ??
    env.GOOGLE_CLOUD_PROJECT?.trim() ??
    env.GCLOUD_PROJECT?.trim() ??
    cred.quotaProjectId;
  if (!project) {
    throw new Error(
      "google-vertex: authorized_user ADC has no project_id; set GOOGLE_CLOUD_PROJECT",
    );
  }

  const mint = deps.mintToken ?? ((c) => getAuthorizedUserAccessToken(c));
  const accessToken = await mint(cred);

  const existingHeaders = options.httpOptions?.headers ?? {};
  return new GoogleGenAI({
    ...options,
    project,
    location: options.location ?? env.GOOGLE_CLOUD_LOCATION?.trim() ?? "global",
    httpOptions: {
      ...options.httpOptions,
      headers: {
        ...existingHeaders,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
