// Qqbot tests cover outbound attachment filename resolution.
import { describe, expect, it } from "vitest";
import { resolveOutboundFileName } from "./outbound-file-name.js";

const UUID = "e46cdea3-a285-48f6-958d-ad31352855d6";

describe("resolveOutboundFileName", () => {
  it("strips the media-store UUID suffix from staged outbound paths", async () => {
    expect(await resolveOutboundFileName(`/data/media/report---${UUID}.png`)).toBe("report.png");
  });

  it("strips the suffix regardless of directory depth", async () => {
    expect(await resolveOutboundFileName(`/a/b/c/quarterly summary---${UUID}.pdf`)).toBe(
      "quarterly summary.pdf",
    );
  });

  it("returns the plain basename for non-staged local paths", async () => {
    expect(await resolveOutboundFileName("/tmp/photo.png")).toBe("photo.png");
  });

  it("returns the basename for remote URLs", async () => {
    expect(await resolveOutboundFileName("https://example.com/files/contract.pdf")).toBe(
      "contract.pdf",
    );
  });

  it("keeps `---` names that are not the UUID staging shape", async () => {
    expect(await resolveOutboundFileName("/tmp/draft---v2.png")).toBe("draft---v2.png");
  });
});
