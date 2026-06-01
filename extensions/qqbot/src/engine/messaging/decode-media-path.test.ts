import { afterEach, describe, expect, it } from "vitest";
import { decodeMediaPath, isFileUriMediaPath } from "./decode-media-path.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function restoreEnv(name: "HOME" | "USERPROFILE", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
});

describe("decodeMediaPath", () => {
  it("identifies file URI media paths before path normalization", () => {
    expect(isFileUriMediaPath(" file:///etc/passwd")).toBe(true);
    expect(isFileUriMediaPath("FILE:///etc/passwd")).toBe(true);
    expect(isFileUriMediaPath("file://%2Fetc%2Fpasswd")).toBe(true);
    expect(isFileUriMediaPath("/tmp/file.txt")).toBe(false);
  });

  it("preserves Windows home-relative paths with digit segments", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = String.raw`C:\Users\operator`;

    expect(decodeMediaPath(String.raw`~\1\photo.png`)).toBe(
      String.raw`C:\Users\operator\1\photo.png`,
    );
  });

  it("prefers USERPROFILE for Windows home-relative paths when HOME is POSIX-style", () => {
    process.env.HOME = "/c/Users/operator";
    process.env.USERPROFILE = String.raw`C:\Users\operator`;

    expect(decodeMediaPath(String.raw`~\1\photo.png`)).toBe(
      String.raw`C:\Users\operator\1\photo.png`,
    );
  });
});
