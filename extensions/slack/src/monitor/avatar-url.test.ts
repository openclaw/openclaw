import { describe, expect, it } from "vitest";
import { resolveSlackAvatarDownloadUrl } from "./avatar-url.js";

const allowlist = ["avatars.slack-edge.com", "*.slack-edge.com"];

describe("resolveSlackAvatarDownloadUrl", () => {
  it("keeps an allowlisted profile image URL as-is", () => {
    const url = "https://avatars.slack-edge.com/user-hash-192.png";
    expect(resolveSlackAvatarDownloadUrl(url, allowlist)).toBe(url);
  });

  it("takes the Slack-hosted fallback of a Gravatar default avatar", () => {
    const url =
      "https://secure.gravatar.com/avatar/0123456789abcdef.jpg?s=192&d=https%3A%2F%2Fa.slack-edge.com%2Fdf10d%2Fimg%2Favatars%2Fava_0001-192.png";
    expect(resolveSlackAvatarDownloadUrl(url, allowlist)).toBe(
      "https://a.slack-edge.com/df10d/img/avatars/ava_0001-192.png",
    );
  });

  it("rejects a fallback whose host is outside the allowlist", () => {
    const url =
      "https://secure.gravatar.com/avatar/0123456789abcdef.jpg?d=https%3A%2F%2Fcdn.example.com%2Fdefault.png";
    expect(resolveSlackAvatarDownloadUrl(url, allowlist)).toBeUndefined();
  });

  it("rejects hosts outside the allowlist without a fallback", () => {
    expect(
      resolveSlackAvatarDownloadUrl("https://cdn.example.com/avatar.png", allowlist),
    ).toBeUndefined();
    expect(
      resolveSlackAvatarDownloadUrl(
        "https://secure.gravatar.com/avatar/abc.jpg?d=identicon",
        allowlist,
      ),
    ).toBeUndefined();
  });

  it("rejects non-https and unparseable values", () => {
    expect(
      resolveSlackAvatarDownloadUrl("http://avatars.slack-edge.com/user.png", allowlist),
    ).toBeUndefined();
    expect(
      resolveSlackAvatarDownloadUrl(
        "https://secure.gravatar.com/avatar/abc.jpg?d=http%3A%2F%2Fa.slack-edge.com%2Fx.png",
        allowlist,
      ),
    ).toBeUndefined();
    expect(resolveSlackAvatarDownloadUrl("not a url", allowlist)).toBeUndefined();
  });
});
