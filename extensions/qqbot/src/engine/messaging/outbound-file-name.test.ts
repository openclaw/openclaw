// Qqbot tests cover outbound attachment filename resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOutboundFileName } from "./outbound-file-name.js";

const UUID = "e46cdea3-a285-48f6-958d-ad31352855d6";

async function mediaStorePath(...segments: string[]): Promise<string> {
  const { getMediaDir } = await import("openclaw/plugin-sdk/media-runtime");
  return path.join(getMediaDir(), ...segments);
}

describe("resolveOutboundFileName", () => {
  it("strips the media-store UUID suffix from staged outbound paths", async () => {
    const staged = await mediaStorePath(`report---${UUID}.png`);
    expect(await resolveOutboundFileName(staged)).toBe("report.png");
  });

  it("strips the suffix regardless of directory depth inside media store", async () => {
    const staged = await mediaStorePath("outbound", `quarterly summary---${UUID}.pdf`);
    expect(await resolveOutboundFileName(staged)).toBe("quarterly summary.pdf");
  });

  it("preserves UUID-shaped basenames outside the media store", async () => {
    expect(await resolveOutboundFileName(`/tmp/report---${UUID}.txt`)).toBe(`report---${UUID}.txt`);
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
