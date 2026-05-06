import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { inspectGoogleChatAccount } from "./account-inspect.js";
import { resolveGoogleChatAccount } from "./accounts.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

const inlineServiceAccount = JSON.stringify({
  type: "service_account",
  client_email: "test@example.iam.gserviceaccount.com",
  private_key: "key",
});

describe("inspectGoogleChatAccount", () => {
  it("reports inline service-account JSON as configured", () => {
    const inspected = inspectGoogleChatAccount({
      cfg: asConfig({
        channels: {
          googlechat: {
            serviceAccount: inlineServiceAccount,
          },
        },
      }),
    });

    expect(inspected.accountId).toBe("default");
    expect(inspected.credentialSource).toBe("inline");
    expect(inspected.configured).toBe(true);
    expect(inspected.enabled).toBe(true);
  });

  it("reports configured_unavailable for SecretRef on serviceAccount without throwing", () => {
    const cfg = asConfig({
      channels: {
        googlechat: {
          serviceAccount: { source: "file", provider: "x", id: "googlechat-sa" },
        },
      },
    });

    const inspected = inspectGoogleChatAccount({ cfg });

    expect(inspected.credentialSource).toBe("configured_unavailable");
    expect(inspected.configured).toBe(true);
    expect(inspected.enabled).toBe(true);

    // Runtime path must still throw — only the inspect path tolerates SecretRef.
    expect(() => resolveGoogleChatAccount({ cfg })).toThrow(/unresolved SecretRef/);
  });

  it("reports configured_unavailable for SecretRef on serviceAccountRef without throwing", () => {
    const cfg = asConfig({
      channels: {
        googlechat: {
          serviceAccountRef: { source: "file", provider: "x", id: "googlechat-sa" },
        },
      },
    });

    const inspected = inspectGoogleChatAccount({ cfg });

    expect(inspected.credentialSource).toBe("configured_unavailable");
    expect(inspected.configured).toBe(true);
    expect(inspected.enabled).toBe(true);

    expect(() => resolveGoogleChatAccount({ cfg })).toThrow(/unresolved SecretRef/);
  });

  it("reports none and configured=false when no credentials are configured", () => {
    const inspected = inspectGoogleChatAccount({
      cfg: asConfig({
        channels: {
          googlechat: {
            audience: "https://chat.googleapis.com",
          },
        },
      }),
    });

    expect(inspected.credentialSource).toBe("none");
    expect(inspected.configured).toBe(false);
  });
});
