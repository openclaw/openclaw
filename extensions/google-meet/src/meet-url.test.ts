import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleMeetSpace } from "./meet-api.js";
import { normalizeMeetUrl, readMeetMeetingCode } from "./meet-url.js";
import { normalizeMeetUrlForReuse } from "./transports/google-meet-urls.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeMeetUrl", () => {
  it("keeps a canonical meeting link as given", () => {
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij?authuser=1")).toBe(
      "https://meet.google.com/abc-defg-hij?authuser=1",
    );
  });

  it("accepts Meet's own /meet/<code> redirect form and normalizes it to /<code>", () => {
    // Meet redirects a joined call to this form; users copy it from the address bar.
    expect(normalizeMeetUrl("https://meet.google.com/meet/koy-hkzt-zgp?hl=en")).toBe(
      "https://meet.google.com/koy-hkzt-zgp?hl=en",
    );
    expect(normalizeMeetUrl("https://meet.google.com/meet/koy-hkzt-zgp")).toBe(
      "https://meet.google.com/koy-hkzt-zgp",
    );
  });

  it("still rejects paths without a meeting code", () => {
    for (const url of [
      "https://meet.google.com/meet",
      "https://meet.google.com/meet/",
      "https://meet.google.com/meet/landing",
      "https://meet.google.com/landing",
      "https://meet.google.com/abc-defg-hijk",
    ]) {
      expect(() => normalizeMeetUrl(url)).toThrow("url must include a Google Meet meeting code");
    }
  });
});

describe("readMeetMeetingCode", () => {
  it("reads the code from both path forms", () => {
    expect(readMeetMeetingCode("/abc-defg-hij")).toBe("abc-defg-hij");
    expect(readMeetMeetingCode("/meet/ABC-DEFG-HIJ")).toBe("abc-defg-hij");
    expect(readMeetMeetingCode("/meet")).toBeUndefined();
    expect(readMeetMeetingCode("/lookup/team-room")).toBeUndefined();
  });
});

describe("normalizeMeetUrlForReuse", () => {
  it("treats a tab on the /meet/<code> form as the same call", () => {
    expect(normalizeMeetUrlForReuse("https://meet.google.com/meet/koy-hkzt-zgp?hl=en")).toBe(
      "https://meet.google.com/koy-hkzt-zgp",
    );
    expect(normalizeMeetUrlForReuse("https://meet.google.com/koy-hkzt-zgp/")).toBe(
      "https://meet.google.com/koy-hkzt-zgp",
    );
    expect(normalizeMeetUrlForReuse("https://meet.google.com/meet")).toBeUndefined();
    expect(normalizeMeetUrlForReuse("https://meet.google.com/meet/koy-hkzt-zgp/x")).toBeUndefined();
  });
});

describe("Meet API space names", () => {
  it("resolves spaces.get by meeting code for both URL forms", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify({ name: url.slice(url.indexOf("spaces")) }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const spaceFor = async (meeting: string) =>
      (await fetchGoogleMeetSpace({ accessToken: "test-token", meeting })).name;

    await expect(spaceFor("https://meet.google.com/koy-hkzt-zgp")).resolves.toBe(
      "spaces/koy-hkzt-zgp",
    );
    // Before: the first path segment ("meet") became the space id.
    await expect(spaceFor("https://meet.google.com/meet/koy-hkzt-zgp?hl=en")).resolves.toBe(
      "spaces/koy-hkzt-zgp",
    );
    await expect(spaceFor("https://meet.google.com/meet")).rejects.toThrow(
      "Google Meet URL did not include a meeting code",
    );
  });
});
