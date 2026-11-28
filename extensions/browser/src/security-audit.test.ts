import { expect, it } from "vitest";
import { collectBrowserSecurityAuditFindings } from "./security-audit.js";

type Config = Parameters<typeof collectBrowserSecurityAuditFindings>[0]["config"];
function finding(config: Config, id: string) {
  return collectBrowserSecurityAuditFindings({
    config,
    sourceConfig: config,
    env: {},
    stateDir: "/tmp/openclaw-state",
    configPath: "/tmp/openclaw.json",
  }).find((entry) => entry.checkId === `browser.${id}`);
}

it.each([true, false])("reports legacy relay authentication only when enabled=%s", (enabled) => {
  const result = finding(
    { browser: { extensionRelay: { allowLegacyAuth: enabled } } },
    "extension_relay_legacy_auth",
  );
  if (enabled) {
    expect(result).toMatchObject({
      severity: "warn",
      remediation: expect.stringContaining("allowLegacyAuth=false"),
    });
  } else {
    expect(result).toBeUndefined();
  }
});

it("flags browser control without auth", () => {
  expect(
    finding(
      {
        gateway: { controlUi: { enabled: false }, auth: {} },
        browser: { enabled: true },
      },
      "control_no_auth",
    ),
  ).toMatchObject({ severity: "critical" });
});

it.each<[string, string, string?]>([
  ["http://example.com:9222", "remote_cdp_http", undefined],
  [
    "http://169.254.169.254:9222/json/version?token=supersecrettokenvalue1234567890",
    "remote_cdp_private_host",
    "token=supers…7890",
  ],
])("warns about remote CDP %s without exposing secrets", (cdpUrl, id, redacted) => {
  const result = finding(
    {
      browser: {
        ...(redacted ? { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } : {}),
        profiles: { remote: { cdpUrl, color: "#0066CC" } },
      },
    },
    id,
  );
  expect(result).toMatchObject({
    severity: "warn",
    ...(redacted ? { detail: expect.stringContaining(redacted) } : {}),
  });
});
