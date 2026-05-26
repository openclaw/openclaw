import { describe, expect, it } from "vitest";
import { imessageDoctor } from "./doctor.js";

describe("imessageDoctor.collectPreviewWarnings", () => {
  it("flags accounts that share the local Messages source", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              "swang430-gmail-com": {},
              default: {},
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      '- channels.imessage: accounts "swang430-gmail-com" and "default" watch the same local Messages source (cliPath=imsg). OpenClaw now runs one watcher (owner: "swang430-gmail-com") and skips the others; set "enabled": false on the duplicates to silence this warning.',
    ]);
  });

  it("includes dbPath in the warning when configured", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              primary: { cliPath: "imsg", dbPath: "/Users/me/chat.db" },
              default: { cliPath: "imsg", dbPath: "/Users/me/chat.db" },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toMatch(/cliPath=imsg, dbPath=\/Users\/me\/chat\.db/);
  });

  it("stays quiet when each enabled account targets a distinct source", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: "/usr/local/bin/imsg-work" },
              home: { cliPath: "/usr/local/bin/imsg-home" },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([]);
  });
});
