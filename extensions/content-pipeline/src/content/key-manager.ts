/**
 * Automatic API key generation and rotation for Google Cloud and OpenRouter.
 *
 * Google: Uses service account + API Keys API to create Gemini-restricted keys.
 * OpenRouter: Uses Management API to create child API keys.
 *
 * Usage:
 *   const km = new KeyManager(config);
 *   await km.initialize();
 *   const key = km.getActiveKey("google"); // rotates automatically
 */

import { readFileSync, existsSync } from "node:fs";

export interface KeyManagerConfig {
  google?: {
    serviceAccountPath: string;
    projectIds: string[];
    maxKeysPerProject?: number;
  };
  openrouter?: {
    managementKey: string;
    keyPrefix?: string;
  };
}

interface ManagedKey {
  provider: string;
  projectId?: string;
  key: string;
  createdAt: number;
  exhausted: boolean;
}

export class KeyManager {
  private config: KeyManagerConfig;
  private keys: ManagedKey[] = [];
  private keyIndex: Record<string, number> = {};

  constructor(config: KeyManagerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Load existing env keys first
    this.loadEnvKeys("google", ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"]);
    this.loadEnvKeys("groq", ["GROQ_API_KEY"]);
    this.loadEnvKeys("openrouter", ["OPENROUTER_API_KEY"]);
    this.loadEnvKeys("cerebras", ["CEREBRAS_API_KEY"]);

    // Auto-generate Google keys if service account is available
    if (this.config.google?.serviceAccountPath) {
      await this.generateGoogleKeys();
    }

    // Auto-generate OpenRouter keys if management key is available
    if (this.config.openrouter?.managementKey) {
      await this.generateOpenRouterKey();
    }

    const counts = this.keys.reduce(
      (acc, k) => {
        acc[k.provider] = (acc[k.provider] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    console.log(`  🔑 Key manager: ${JSON.stringify(counts)}`);
  }

  private loadEnvKeys(provider: string, envNames: string[]) {
    for (const envName of envNames) {
      const val = process.env[envName];
      if (val) {
        this.keys.push({
          provider,
          key: val,
          createdAt: Date.now(),
          exhausted: false,
        });
      }

      // Check numbered keys: PROVIDER_API_KEY_1, _2, etc.
      for (let i = 1; i <= 10; i++) {
        const numbered = process.env[`${envName}_${i}`];
        if (numbered && numbered !== val) {
          this.keys.push({
            provider,
            key: numbered,
            createdAt: Date.now(),
            exhausted: false,
          });
        }
      }
    }
  }

  /** Get the next available key for a provider, rotating on each call */
  getActiveKey(provider: string): string | undefined {
    const available = this.keys.filter((k) => k.provider === provider && !k.exhausted);
    if (available.length === 0) return undefined;

    const idx = (this.keyIndex[provider] ?? 0) % available.length;
    this.keyIndex[provider] = idx + 1;
    return available[idx].key;
  }

  /** Mark a key as rate-limited/exhausted */
  markExhausted(provider: string, key: string) {
    const entry = this.keys.find((k) => k.provider === provider && k.key === key);
    if (entry) {
      entry.exhausted = true;
      console.warn(
        `  🔑 Key exhausted for ${provider}, ${this.countAvailable(provider)} remaining`,
      );
    }

    // Reset exhausted keys after 1 hour
    setTimeout(() => {
      if (entry) entry.exhausted = false;
    }, 3600_000);
  }

  countAvailable(provider: string): number {
    return this.keys.filter((k) => k.provider === provider && !k.exhausted).length;
  }

  // ── Google Cloud API Key Generation ──

  private async generateGoogleKeys(): Promise<void> {
    const { serviceAccountPath, projectIds, maxKeysPerProject = 2 } = this.config.google!;

    if (!existsSync(serviceAccountPath)) {
      console.warn(`  🔑 Google service account not found: ${serviceAccountPath}`);
      return;
    }

    try {
      const sa = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));
      const token = await this.getGoogleOAuthToken(sa);

      for (const projectId of projectIds) {
        for (let i = 0; i < maxKeysPerProject; i++) {
          try {
            const key = await this.createGoogleApiKey(projectId, token, i);
            if (key) {
              this.keys.push({
                provider: "google",
                projectId,
                key,
                createdAt: Date.now(),
                exhausted: false,
              });
            }
          } catch (err) {
            console.warn(
              `  🔑 Failed to create Google key in ${projectId}: ${(err as Error).message}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`  🔑 Google key generation failed: ${(err as Error).message}`);
    }
  }

  private async getGoogleOAuthToken(sa: {
    client_email: string;
    private_key: string;
  }): Promise<string> {
    // Create JWT for service account
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
      }),
    );

    // Sign with private key
    const crypto = await import("node:crypto");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(sa.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) throw new Error(`OAuth token failed: ${resp.status}`);
    const data = (await resp.json()) as { access_token: string };
    return data.access_token;
  }

  private async createGoogleApiKey(
    projectId: string,
    oauthToken: string,
    index: number,
  ): Promise<string | undefined> {
    const displayName = `pipeline-auto-${index}-${Date.now()}`;

    // Create key with Gemini API restriction
    const createResp = await fetch(
      `https://apikeys.googleapis.com/v2/projects/${projectId}/locations/global/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          restrictions: {
            apiTargets: [{ service: "generativelanguage.googleapis.com" }],
          },
        }),
      },
    );

    if (!createResp.ok) {
      const err = await createResp.text();
      throw new Error(`Create key failed (${createResp.status}): ${err}`);
    }

    const operation = (await createResp.json()) as {
      name: string;
      done?: boolean;
      response?: { keyString?: string };
    };

    // Poll operation until done
    let result = operation;
    for (let attempt = 0; attempt < 10 && !result.done; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollResp = await fetch(`https://apikeys.googleapis.com/v2/${result.name}`, {
        headers: { Authorization: `Bearer ${oauthToken}` },
      });
      result = (await pollResp.json()) as typeof operation;
    }

    // Get the key string
    if (result.response?.keyString) {
      return result.response.keyString;
    }

    // If keyString isn't in operation response, fetch the key directly
    const keyName = result.name?.replace(/operations\/.*/, "") || result.name;
    if (keyName) {
      const keyResp = await fetch(`https://apikeys.googleapis.com/v2/${keyName}/keyString`, {
        headers: { Authorization: `Bearer ${oauthToken}` },
      });
      if (keyResp.ok) {
        const keyData = (await keyResp.json()) as { keyString: string };
        return keyData.keyString;
      }
    }

    return undefined;
  }

  // ── OpenRouter Key Generation ──

  private async generateOpenRouterKey(): Promise<void> {
    const { managementKey, keyPrefix = "pipeline-auto" } = this.config.openrouter!;

    try {
      const name = `${keyPrefix}-${Date.now()}`;
      const resp = await fetch("https://openrouter.ai/api/v1/keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${managementKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, limit: 0 }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.warn(`  🔑 OpenRouter key creation failed: ${err}`);
        return;
      }

      const data = (await resp.json()) as { data?: { key?: string } };
      const key = data.data?.key;
      if (key) {
        this.keys.push({
          provider: "openrouter",
          key,
          createdAt: Date.now(),
          exhausted: false,
        });
        console.log(`  🔑 Auto-generated OpenRouter key: ${name}`);
      }
    } catch (err) {
      console.warn(`  🔑 OpenRouter key generation failed: ${(err as Error).message}`);
    }
  }
}
