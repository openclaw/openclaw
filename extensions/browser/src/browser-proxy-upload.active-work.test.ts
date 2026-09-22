import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE } from "./browser-proxy-envelope.js";
import {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork,
  stageBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps upload recovery, retained files, and their cleanup busy until settled", async () => {
  const uploadDir = tempDirs.make("openclaw-browser-upload-idle-");
  let staged: Awaited<ReturnType<typeof stageBrowserProxyUploadRequest>> | undefined;
  try {
    expect(hasBrowserProxyUploadWork()).toBe(false);
    const recovery = ensureBrowserProxyUploadCleanup({ uploadDir });
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await recovery;
    expect(hasBrowserProxyUploadWork()).toBe(false);

    staged = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { ref: "e1" },
      upload: {
        envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
        files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
      },
      uploadDir,
    });
    expect(hasBrowserProxyUploadWork()).toBe(true);

    const cleanup = discardStagedBrowserProxyUpload(staged);
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await cleanup;
    expect(hasBrowserProxyUploadWork()).toBe(false);
  } finally {
    if (staged) {
      await discardStagedBrowserProxyUpload(staged);
    }
  }
});
