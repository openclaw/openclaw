import { describe, it, expect } from "vitest";
import { validateFileUrls, validateDownloadPath } from "./validation.js";

describe("validateFileUrls", () => {
  const cameraHost = "http://192.168.1.1";

  it("accepts URLs matching camera host", () => {
    expect(() =>
      validateFileUrls(
        ["http://192.168.1.1/file1.mp4", "http://192.168.1.1/file2.mp4"],
        cameraHost,
      ),
    ).not.toThrow();
  });

  it("rejects URLs not matching camera host", () => {
    expect(() => validateFileUrls(["http://evil.com/file.mp4"], cameraHost)).toThrow(
      "URL http://evil.com/file.mp4 does not match camera host http://192.168.1.1",
    );
  });

  it("rejects empty array", () => {
    expect(() => validateFileUrls([], cameraHost)).toThrow("No file URLs provided.");
  });
});

describe("validateDownloadPath", () => {
  const baseDir = "/tmp/downloads";

  it("rejects path traversal", () => {
    expect(() => validateDownloadPath("/tmp/downloads/../../etc/passwd", baseDir)).toThrow(
      "Path /tmp/downloads/../../etc/passwd resolves outside allowed directory /tmp/downloads",
    );
  });

  it("accepts valid subpath", () => {
    expect(() => validateDownloadPath("/tmp/downloads/video.mp4", baseDir)).not.toThrow();
  });
});
