import { describe, expect, it } from "vitest";
import { inferTabType } from "./tab-state";

describe("inferTabType", () => {
  it("recognizes settings virtual tabs", () => {
    expect(inferTabType("~settings")).toBe("settings");
  });

  it("maps legacy ~integrations to settings", () => {
    expect(inferTabType("~integrations")).toBe("settings");
  });

  it("keeps cron virtual tabs recognized", () => {
    expect(inferTabType("~cron/job-1")).toBe("cron");
  });

  it("returns file for regular paths", () => {
    expect(inferTabType("knowledge/notes.md")).toBe("file");
  });

  it("returns app for .dench.app paths", () => {
    expect(inferTabType("myapp.dench.app")).toBe("app");
  });
});
