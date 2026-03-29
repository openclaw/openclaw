import { describe, expect, it } from "vitest";
import { resolveAllowedJiraFields, resolveJiraCloudConfig } from "./config.js";

describe("jira cloud config", () => {
  it("resolves strict config and defaults", () => {
    const cfg = resolveJiraCloudConfig({
      cfg: {
        plugins: {
          entries: {
            "jira-cloud": {
              config: {
                siteUrl: "https://example.atlassian.net/",
                email: "bot@example.com",
                apiToken: "top-secret-token",
                defaultProjectKey: "ops",
              },
            },
          },
        },
      } as never,
      env: {},
    });

    expect(cfg.siteUrl).toBe("https://example.atlassian.net");
    expect(cfg.defaultProjectKey).toBe("OPS");
    expect(cfg.requestTimeoutMs).toBe(15_000);
    expect(cfg.retryCount).toBe(2);
  });

  it("supports env fallbacks and fails closed without credentials", () => {
    const cfg = resolveJiraCloudConfig({
      cfg: {} as never,
      env: {
        JIRA_CLOUD_SITE_URL: "https://env.atlassian.net",
        JIRA_CLOUD_EMAIL: "env@example.com",
        JIRA_CLOUD_API_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });
    expect(cfg.siteUrl).toBe("https://env.atlassian.net");

    expect(() =>
      resolveJiraCloudConfig({
        cfg: {} as never,
        env: {},
      }),
    ).toThrow(/siteUrl\/baseUrl, email, and apiToken are required/);
  });

  it("only returns allowlisted fields", () => {
    expect(resolveAllowedJiraFields(["summary", "status", "drop_table", ""])).toEqual([
      "summary",
      "status",
    ]);
  });
});

