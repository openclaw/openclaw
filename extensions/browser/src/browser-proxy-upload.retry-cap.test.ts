import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE } from "./browser-proxy-envelope.js";

const probeWarns = vi.hoisted(() => [] as string[]);
const probeErrors = vi.hoisted(() => [] as string[]);

vi.mock("openclaw/plugin-sdk/runtime-env", () => {
  const logger = {
    warn: (message: unknown) => {
      probeWarns.push(String(message));
    },
    error: (message: unknown) => {
      probeErrors.push(String(message));
    },
    debug: () => {},
    trace: () => {},
    info: () => {},
    child: () => logger,
    isEnabled: () => false,
  };
  return { createSubsystemLogger: () => logger };
});

const {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork,
  stageBrowserProxyUploadRequest,
} = await import("./browser-proxy-upload.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RETRY_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
// Captured before fake timers replace the global; fs threadpool completions
// still need real event-loop time to settle.
const realSetTimeout = setTimeout;
// chmod(000) cannot produce EACCES on Windows or for root, matching the
// neighboring browser permission-test guards.
const chmodFaultUnavailable =
  process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

async function waitForReal(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 20);
    });
  }
  throw new Error("timed out waiting for asynchronous cleanup state");
}

function recoveryWarns(): string[] {
  return probeWarns.filter((message) => message.includes("recovery failed; retrying"));
}

function recoveryErrors(): string[] {
  return probeErrors.filter((message) => message.includes("recovery gave up"));
}

function cleanupWarns(): string[] {
  return probeWarns.filter((message) => message.includes("cleanup failed; retrying"));
}

function cleanupErrors(): string[] {
  return probeErrors.filter((message) => message.includes("cleanup gave up"));
}

async function makeStagedUpload(rootPrefix: string): Promise<{
  stagingRoot: string;
  staged: string;
}> {
  const root = tempDirs.make(rootPrefix);
  const stagingRoot = path.join(root, "uploads", ".proxy-uploads");
  const staged = path.join(stagingRoot, "upload-x");
  await fs.mkdir(path.join(staged, "0"), { recursive: true });
  await fs.writeFile(path.join(staged, "f.txt"), "x");
  return { stagingRoot, staged };
}

it.skipIf(chmodFaultUnavailable)(
  "bounds recovery retries and unpins active work after giving up",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = tempDirs.make("openclaw-browser-proxy-recovery-cap-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.chmod(stagingRoot, 0o000);
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      // Three command-driven attempts: two retries, then a single error and give-up.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      // Further command-driven and explicit recovery entries stay silent.
      await ensureBrowserProxyUploadCleanup({ uploadDir });
      await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      // No retry timer was armed, so active work is unpinned.
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // Even if a timer had been armed, advancing past it must stay silent.
      await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 100);
      });
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
    } finally {
      vi.useRealTimers();
      await fs.chmod(stagingRoot, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)("resets the recovery attempt count after a success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const root = tempDirs.make("openclaw-browser-proxy-recovery-reset-");
  const uploadDir = path.join(root, "uploads");
  const stagingRoot = path.join(uploadDir, ".proxy-uploads");
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.chmod(stagingRoot, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    await ensureBrowserProxyUploadCleanup({ uploadDir });
    expect(recoveryWarns().length).toBe(1);
    // Fault clears; the next explicit recovery succeeds and resets the count.
    await fs.chmod(stagingRoot, 0o700);
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // A fresh fault earns a fresh attempt budget: two warns before the give-up.
    await fs.chmod(stagingRoot, 0o000);
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    expect(recoveryWarns().length).toBe(3);
    expect(recoveryErrors().length).toBe(1);
  } finally {
    vi.useRealTimers();
    await fs.chmod(stagingRoot, 0o700).catch(() => {});
  }
});

it.skipIf(chmodFaultUnavailable)(
  "bounds cleanup retries and unpins active work after giving up",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { staged } = await makeStagedUpload("openclaw-browser-proxy-cleanup-cap-");
    await fs.chmod(staged, 0o000);
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      await discardStagedBrowserProxyUpload({ body: {}, directory: staged });
      expect(cleanupWarns().length).toBe(1);
      expect(hasBrowserProxyUploadWork()).toBe(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await waitForReal(() => cleanupWarns().length >= 2);
      expect(hasBrowserProxyUploadWork()).toBe(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await waitForReal(() => cleanupErrors().length >= 1);
      expect(cleanupWarns().length).toBe(2);
      // Giving up cleared the pending retry timer, so active work is unpinned.
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // No further retries fire after the give-up.
      await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 100);
      });
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
    } finally {
      vi.useRealTimers();
      await fs.chmod(staged, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)("resets the cleanup attempt count after a success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const first = await makeStagedUpload("openclaw-browser-proxy-cleanup-reset-a-");
  await fs.chmod(first.staged, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    await discardStagedBrowserProxyUpload({ body: {}, directory: first.staged });
    expect(cleanupWarns().length).toBe(1);
    // Fault clears; the armed retry succeeds, removes the directory, resets count.
    await fs.chmod(first.staged, 0o700);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // A fresh fault on a new staged upload earns a fresh attempt budget.
    const second = await makeStagedUpload("openclaw-browser-proxy-cleanup-reset-b-");
    await fs.chmod(second.staged, 0o000);
    await discardStagedBrowserProxyUpload({ body: {}, directory: second.staged });
    expect(cleanupWarns().length).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupWarns().length >= 3);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupErrors().length >= 1);
    expect(cleanupWarns().length).toBe(3);
    expect(cleanupErrors().length).toBe(1);
    await fs.chmod(second.staged, 0o700).catch(() => {});
  } finally {
    vi.useRealTimers();
    await fs.chmod(first.staged, 0o700).catch(() => {});
  }
});

it.skipIf(chmodFaultUnavailable)(
  "resumes recovery after a successful staging when the fault cleared",
  async () => {
    const root = tempDirs.make("openclaw-browser-proxy-resume-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const expired = path.join(stagingRoot, "upload-expired");
    await fs.mkdir(expired, { recursive: true });
    await fs.writeFile(
      path.join(expired, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
    );
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(expired, past, past);
    await fs.chmod(stagingRoot, 0o000);
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      // Exhaust the recovery budget while the staging root is unreadable.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      // The fault clears; staging succeeds, which must resume recovery and
      // re-evaluate retained uploads before quota admission.
      await fs.chmod(stagingRoot, 0o700);
      const staged = await stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "e1" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
        },
        uploadDir,
      });
      try {
        await expect(fs.stat(expired)).rejects.toHaveProperty("code", "ENOENT");
        expect(recoveryErrors().length).toBe(1);
      } finally {
        await discardStagedBrowserProxyUpload(staged);
      }
    } finally {
      await fs.chmod(stagingRoot, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "keeps the exhausted recovery budget silent across upload attempts during a persistent fault",
  async () => {
    const root = tempDirs.make("openclaw-browser-proxy-persistent-recovery-fault-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.chmod(stagingRoot, 0o000);
    const upload = () =>
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "blocked" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "f.txt", contentBase64: Buffer.from("x").toString("base64") }],
        },
        uploadDir,
      });
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      // Upload attempts while the root fault persists must not restart the
      // exhausted budget: staging keeps failing and recovery stays silent.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(upload()).rejects.toMatchObject({
          code: expect.stringMatching(/^E(ACCES|PERM)$/),
        });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // Once the fault clears, the preserved budget resumes on the next upload.
      await fs.chmod(stagingRoot, 0o700);
      const staged = await upload();
      await discardStagedBrowserProxyUpload(staged);
    } finally {
      await fs.chmod(stagingRoot, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "resumes cleanup-only exhaustion after the deletion fault clears",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = tempDirs.make("openclaw-browser-proxy-cleanup-only-resume-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const expired = path.join(stagingRoot, "upload-expired");
    await fs.mkdir(expired, { recursive: true });
    await fs.writeFile(
      path.join(expired, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
    );
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(expired, past, past);
    // A read-only staging keeps recovery scans working while blocking removal.
    await fs.chmod(expired, 0o500);
    const upload = () =>
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "e1" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
        },
        uploadDir,
      });
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      // Exhaust the cleanup budget; recovery scans keep succeeding, so the
      // give-up is cleanup-only and never trips the recovery reset.
      await ensureBrowserProxyUploadCleanup({ uploadDir });
      expect(cleanupWarns().length).toBe(1);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await waitForReal(() => cleanupWarns().length >= 2);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await waitForReal(() => cleanupErrors().length >= 1);
      expect(cleanupErrors().length).toBe(1);
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // Uploads still stage (the fault only blocks deletion) and must not
      // restart the cleanup retry loop while it persists.
      const blocked = await upload();
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
      await discardStagedBrowserProxyUpload(blocked);
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // The fault clears; the next upload reclaims the expired copy.
      await fs.chmod(expired, 0o700);
      const staged = await upload();
      try {
        await expect(fs.stat(expired)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        await discardStagedBrowserProxyUpload(staged);
      }
    } finally {
      vi.useRealTimers();
      await fs.chmod(expired, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "keeps exhaustion latched while a marked upload descendant stays unreadable",
  async () => {
    const root = tempDirs.make("openclaw-browser-proxy-descendant-fault-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const expired = path.join(stagingRoot, "upload-expired");
    await fs.mkdir(path.join(expired, "0"), { recursive: true });
    await fs.writeFile(path.join(expired, "0", "f.txt"), "x");
    await fs.writeFile(
      path.join(expired, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
    );
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(expired, past, past);
    // The root stays readable; only the numbered child directory faults.
    await fs.chmod(path.join(expired, "0"), 0o000);
    const upload = () =>
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "e1" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
        },
        uploadDir,
      });
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      // A readable root does not prove the complete scan works: the unreadable
      // descendant must keep the exhausted budget latched and silent instead
      // of clearing it and re-arming the recovery retry loop.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(upload()).rejects.toMatchObject({
          code: expect.stringMatching(/^E(ACCES|PERM)$/),
        });
      }
      expect(recoveryWarns().length).toBe(2);
      expect(recoveryErrors().length).toBe(1);
      await waitForReal(() => !hasBrowserProxyUploadWork());
      // Repairing the descendant lets the next upload unlatch recovery and
      // reclaim the expired copy.
      await fs.chmod(path.join(expired, "0"), 0o700);
      const staged = await upload();
      try {
        await expect(fs.stat(expired)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        await discardStagedBrowserProxyUpload(staged);
      }
    } finally {
      await fs.chmod(path.join(expired, "0"), 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "re-probes an unexpired exhausted discard instead of restoring its retention timer",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const root = tempDirs.make("openclaw-browser-proxy-unexpired-discard-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const staged = path.join(stagingRoot, "upload-x");
    await fs.mkdir(path.join(staged, "0"), { recursive: true });
    await fs.writeFile(path.join(staged, "0", "f.txt"), "x");
    await fs.writeFile(
      path.join(staged, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
    );
    // A read-only directory stays readable for scans while blocking removal;
    // its fresh mtime keeps the copy well inside its retention window.
    await fs.chmod(staged, 0o500);
    const upload = () =>
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "e1" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
        },
        uploadDir,
      });
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await discardStagedBrowserProxyUpload({ body: {}, directory: staged });
      }
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
      // While the deletion fault persists, the next upload re-probes the
      // exhausted discard silently: the discarded copy must not be
      // rescheduled as a retained upload, so no restored retention timer may
      // pin active work and no retry loop may restart.
      const blocked = await upload();
      await discardStagedBrowserProxyUpload(blocked);
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
      await waitForReal(() => !hasBrowserProxyUploadWork());
      await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 100);
      });
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
      await expect(fs.stat(staged)).resolves.toBeDefined();
      // Repairing the fault lets the next upload reclaim the discarded copy
      // even though its retention window has not expired.
      await fs.chmod(staged, 0o700);
      const stagedRequest = await upload();
      try {
        await expect(fs.stat(staged)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        await discardStagedBrowserProxyUpload(stagedRequest);
      }
      expect(cleanupWarns().length).toBe(2);
      expect(cleanupErrors().length).toBe(1);
    } finally {
      vi.useRealTimers();
      await fs.chmod(staged, 0o700).catch(() => {});
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "reclaims a partially deleted upload that lost the ownership marker",
  async () => {
    const root = tempDirs.make("openclaw-browser-proxy-partial-delete-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const staged = path.join(stagingRoot, "upload-x");
    await fs.mkdir(path.join(staged, "0"), { recursive: true });
    await fs.writeFile(path.join(staged, "0", "f.txt"), "x");
    await fs.writeFile(
      path.join(staged, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
    );
    // A never-recorded unmarked directory must survive recovery untouched.
    const foreign = path.join(stagingRoot, "upload-foreign");
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, "keep.txt"), "keep");
    // Block deletion of the file inside the numbered child directory; partial
    // recursive removal can already have unlinked the ownership marker.
    await fs.chmod(path.join(staged, "0"), 0o500);
    try {
      probeWarns.length = 0;
      probeErrors.length = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await discardStagedBrowserProxyUpload({ body: {}, directory: staged });
      }
      expect(cleanupErrors().length).toBe(1);
      // Normalize the partial-deletion outcome: no ownership marker remains
      // while the file inside the still non-writable child directory stays.
      await fs.rm(path.join(staged, ".openclaw-browser-proxy-upload-v1"), { force: true });
      await expect(fs.stat(path.join(staged, "0", "f.txt"))).resolves.toBeDefined();
      // Repair the deletion fault; the recorded remnant must be reclaimed even
      // though the marker-gated scan can no longer see it.
      await fs.chmod(path.join(staged, "0"), 0o700);
      const stagedRequest = await stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { ref: "e1" },
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
        },
        uploadDir,
      });
      try {
        await expect(fs.stat(staged)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        await discardStagedBrowserProxyUpload(stagedRequest);
      }
      await expect(fs.stat(foreign)).resolves.toBeDefined();
    } finally {
      await fs.chmod(path.join(staged, "0"), 0o700).catch(() => {});
    }
  },
);
