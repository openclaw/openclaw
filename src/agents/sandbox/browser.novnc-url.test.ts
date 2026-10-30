// noVNC auth tests cover observer URL construction, one-time tokens, and
// password generation for sandbox browser viewing.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  issueNoVncObserverToken,
} from "./novnc-auth.js";

describe("noVNC auth helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("issues one-time short-lived observer tokens", () => {
    // Observer tokens are bearer access to a browser session, so consumption is
    // one-shot and bounded by a short TTL.
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1050);
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });
    expect(buildNoVncObserverTokenUrl("http://127.0.0.1:19999", token)).toBe(
      `http://127.0.0.1:19999/sandbox/novnc?token=${token}`,
    );
    expect(consumeNoVncObserverToken(token)).toEqual({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });
    expect(consumeNoVncObserverToken(token)).toBeNull();
  });

  it("expires observer tokens after the short default ttl", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(61_001);
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });

    expect(consumeNoVncObserverToken(token)).toBeNull();
  });

  it("does not issue usable observer tokens when the issue time is invalid", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(Number.NaN).mockReturnValue(1050);
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });

    expect(consumeNoVncObserverToken(token)).toBeNull();
  });
});
