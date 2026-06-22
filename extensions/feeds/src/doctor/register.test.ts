import { describe, expect, it } from "vitest";
import {
  evaluateFeedsConfig,
  FEEDS_CHECK_IDS,
  registerFeedsDoctorChecks,
  resetFeedsDoctorChecksForTest,
} from "./register.js";

describe("Feeds doctor checks", () => {
  it("registers each feeds health check once", () => {
    const registered: string[] = [];
    resetFeedsDoctorChecksForTest();

    registerFeedsDoctorChecks({
      registerHealthCheck(check) {
        registered.push(check.id);
      },
    });

    expect(registered).toEqual(FEEDS_CHECK_IDS);
  });

  it("accepts configured https and file feed sources", () => {
    const findings = evaluateFeedsConfig({
      cfg: {
        plugins: {
          entries: {
            feeds: {
              enabled: true,
              config: {
                sources: [
                  {
                    id: "company-approved",
                    url: "https://feeds.example.com/openclaw/feed.json",
                    trust: "pinned",
                    integrity:
                      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                  },
                  {
                    id: "local-review",
                    url: "file:///opt/openclaw/feeds/review.json",
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(findings).toEqual([]);
  });

  it("reports duplicate ids, unsupported urls, and missing pinned integrity", () => {
    const findings = evaluateFeedsConfig({
      cfg: {
        plugins: {
          entries: {
            feeds: {
              enabled: true,
              config: {
                sources: [
                  { id: "company", url: "https://feeds.example.com/openclaw/feed.json" },
                  { id: "company", url: "http://feeds.example.com/feed.json" },
                  { id: "pinned", url: "https://feeds.example.com/pinned.json", trust: "pinned" },
                ],
              },
            },
          },
        },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "feeds/source-duplicate-id",
          ocPath: "oc://openclaw.config/plugins/entries/feeds/config/sources/#1/id",
        }),
        expect.objectContaining({
          checkId: "feeds/source-url-invalid",
          ocPath: "oc://openclaw.config/plugins/entries/feeds/config/sources/#1/url",
        }),
        expect.objectContaining({
          checkId: "feeds/source-integrity-missing",
          ocPath: "oc://openclaw.config/plugins/entries/feeds/config/sources/#2/integrity",
        }),
      ]),
    );
  });

  it("warns when the enabled feeds plugin has no sources", () => {
    const findings = evaluateFeedsConfig({
      cfg: {
        plugins: {
          entries: {
            feeds: {
              enabled: true,
              config: {},
            },
          },
        },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "feeds/source-missing",
        severity: "warning",
        ocPath: "oc://openclaw.config/plugins/entries/feeds/config/sources",
      }),
    ]);
  });
});
