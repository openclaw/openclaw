import { describe, expect, it } from "vitest";
import { sessionShareControlUiOrigin, sessionShareOriginalUrl } from "./original-url.js";
import { parseSessionSharePage } from "./wire.js";

const origin = "https://source.example";
const key = "agent:research:planning";
const path = "/chat/research/planning";

describe("receiver-owned source URLs", () => {
  it("combines only the approved origin and base path with the qualified source path", () => {
    expect(sessionShareOriginalUrl(origin, key, path, "/control/")).toBe(
      `${origin}/control${path}`,
    );
    expect(sessionShareOriginalUrl(origin, key, undefined)).toBeUndefined();
    expect(sessionShareOriginalUrl(undefined, key, path)).toBeUndefined();
  });
  it.each([
    "//other.example/chat/research/planning",
    "https://other.example/chat/research/planning",
    "/chat/research/planning?token=x",
    "/chat/research/planning#x",
    "/chat/research/../planning",
    "/chat/research/%2E%2E/planning",
    "/chat\\research\\planning",
    "/chat/other/planning",
    "/chat/research",
  ])("refuses unbound source path %s", (sourcePath) => {
    expect(sessionShareOriginalUrl(origin, key, sourcePath, "/control")).toBeUndefined();
  });
  it.each(["//other.example", "/a/../control", "/control?token=x", "/control#x", "/a\\b"])(
    "refuses a rewritten base path %s",
    (basePath) => {
      expect(sessionShareOriginalUrl(origin, key, path, basePath)).toBeUndefined();
    },
  );
  it.each([
    "https://user:secret@source.example",
    "https://source.example/path",
    "//source.example",
    "javascript:alert(1)",
    "https://source.example?token=x",
    "https://source.example#x",
  ])("refuses an unapproved origin %s", (value) =>
    expect(sessionShareControlUiOrigin(value)).toBeUndefined(),
  );
});

it("keeps the old closed wire schema and opts into link metadata only for the advertised command", () => {
  const session = {
    threadId: key,
    status: "idle",
    archived: false,
    canContinue: false,
    canArchive: false,
  };
  expect(parseSessionSharePage({ sessions: [session] }).sessions).toEqual([session]);
  expect(() => parseSessionSharePage({ sessions: [{ ...session, originalPath: path }] })).toThrow(
    "Invalid",
  );
  expect(
    parseSessionSharePage({ sessions: [{ ...session, originalPath: path }] }, true).sessions,
  ).toEqual([{ ...session, originalPath: path }]);
});
