import { describe, expect, it, vi } from "vitest";
import { createChatPullRequestInvalidation } from "./chat-pull-request-invalidation.ts";
const key = "agent:main:demo";
const text = "Opened https://github.com/openclaw/openclaw/pull/111532";
const message = { role: "assistant", content: [{ type: "text", text }] };
function fixture() {
  const refresh = vi.fn(() => true);
  return { refresh, owner: createChatPullRequestInvalidation(refresh) };
}
describe("plugin chat freshness emission receipts", () => {
  it.each(["stream", "final"] as const)("records only admitted %s refreshes", (phase) => {
    const { refresh, owner } = fixture();
    const emit = () =>
      phase === "stream" ? owner.stream(key, "run-1", text) : owner.final(key, "run-1", message);
    refresh.mockReturnValueOnce(false);
    emit();
    emit();
    emit();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(key);
  });
  it("finds a split streamed link and retains a separate final receipt", () => {
    const { refresh, owner } = fixture();
    owner.stream(key, "run-1", "Opened https://github.com/openclaw/openclaw/pu");
    expect(refresh).not.toHaveBeenCalled();
    owner.stream(key, "run-1", "ll/111532");
    owner.stream(key, "run-1", " with updates");
    owner.final(key, "run-1", {
      role: "assistant",
      content: [{ type: "text", text: "Published." }],
    });
    owner.final(key, "run-1", {
      role: "assistant",
      content: [{ type: "text", text: "Published." }],
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it.each([
    { name: "legacy text", first: { text }, second: message, count: 1 },
    {
      name: "different native IDs",
      first: { ...message, __openclaw: { id: "first" } },
      second: { ...message, __openclaw: { id: "second" } },
      count: 2,
    },
    {
      name: "import identity",
      first: {
        ...message,
        __openclaw: {
          id: "first",
          importedFrom: "fixture",
          cliSessionId: "source",
          externalId: "same",
        },
      },
      second: {
        ...message,
        __openclaw: {
          id: "second",
          importedFrom: "fixture",
          cliSessionId: "source",
          externalId: "same",
        },
      },
      count: 1,
    },
  ])("preserves $name final identity", ({ first, second, count }) => {
    const { refresh, owner } = fixture();
    owner.final(key, "run-1", first);
    owner.final(key, "run-1", second);
    expect(refresh).toHaveBeenCalledTimes(count);
  });
  it("keeps distinct native sequence identities independent", () => {
    const { refresh, owner } = fixture();
    owner.final(key, "run-1", { ...message, __openclaw: { seq: 1 } });
    owner.final(key, "run-1", { ...message, __openclaw: { seq: 2 } });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("retires receipts on connection, structural reset, and unwatched session ownership", () => {
    const { refresh, owner } = fixture();
    owner.final(key, "run-1", message);
    owner.reset();
    owner.final(key, "run-1", message);
    owner.reset(key);
    owner.final(key, "run-1", message);
    owner.retain(new Set(["other"]));
    owner.final(key, "run-1", message);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
  it("keeps sessions, runs and unidentified finals independent", () => {
    const { refresh, owner } = fixture();
    owner.final(key, "first", message);
    owner.final(key, "later", message);
    owner.final("other", "later", message);
    owner.final(key, undefined, message);
    owner.final(key, undefined, message);
    expect(refresh).toHaveBeenCalledTimes(5);
  });
  it("bounds receipts and deduplicates complete large-content identities", () => {
    const { refresh, owner } = fixture();
    for (let index = 0; index < 1000; index += 1) {
      owner.final(key, `run-${index}`, message);
    }
    owner.final(key, "run-999", message);
    expect(refresh).toHaveBeenCalledTimes(1000);
    owner.final(key, "run-0", message);
    expect(refresh).toHaveBeenCalledTimes(1001);
    const large = { ...message, content: [{ type: "text", text: text + " " + "x".repeat(50000) }] };
    owner.final(key, "large", large);
    owner.final(key, "large", large);
    expect(refresh).toHaveBeenCalledTimes(1002);
    owner.final(key, "large", {
      ...large,
      content: [{ type: "text", text: text + " " + "x".repeat(50000) + "different" }],
    });
    expect(refresh).toHaveBeenCalledTimes(1003);
  });
  it.each([
    "https://github.com/owner/repo/issues/1",
    "https://github.com.evil.test/owner/repo/pull/1",
    "https://github.com/owner/repo/pull/1/unrelated",
    "https://github.com/%/repo/pull/1",
  ])("ignores a non-PR target %s", (url) => {
    const { refresh, owner } = fixture();
    owner.stream(key, "run", url);
    owner.final(key, "run", { role: "assistant", text: url });
    expect(refresh).not.toHaveBeenCalled();
  });
});
