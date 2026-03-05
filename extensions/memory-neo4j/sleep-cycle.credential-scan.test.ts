/**
 * Tests for credential scanning in the sleep cycle.
 *
 * Verifies that CREDENTIAL_PATTERNS and detectCredential() correctly
 * identify credential-like content in memory text while not flagging
 * clean text, and that the sleep cycle paginated batch scan works correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import type { Logger } from "./schema.js";
import { CREDENTIAL_PATTERNS, detectCredential, runSleepCycle } from "./sleep-cycle.js";

describe("Credential Detection", () => {
  // --------------------------------------------------------------------------
  // detectCredential() — should flag dangerous content
  // --------------------------------------------------------------------------

  describe("should detect credentials", () => {
    it("detects API keys (sk-...)", () => {
      const result = detectCredential("Use the key sk-abc123def456ghi789jkl012mno345");
      expect(result).toBe("API key");
    });

    it("detects api_key patterns", () => {
      const result = detectCredential("Set api_key_live_abcdef1234567890abcdef");
      expect(result).toBe("API key");
    });

    it("detects Bearer tokens", () => {
      const result = detectCredential(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      );
      // Could match either Bearer token or JWT — both are valid detections
      expect(result).not.toBeNull();
    });

    it("detects password assignments (password: X)", () => {
      const result = detectCredential("The database password: myS3cretP@ss!");
      expect(result).toBe("Password assignment");
    });

    it("detects password assignments (password=X)", () => {
      const result = detectCredential("config has password=hunter2 in it");
      expect(result).toBe("Password assignment");
    });

    it("detects the missed pattern: login with X creds user/pass", () => {
      const result = detectCredential("login with radarr creds hullah/fuckbar");
      expect(result).toBe("Credentials (user/pass)");
    });

    it("detects creds user/pass without login prefix", () => {
      const result = detectCredential("use creds admin/password123 for the server");
      expect(result).toBe("Credentials (user/pass)");
    });

    it("detects URL-embedded credentials", () => {
      const result = detectCredential("Connect to https://admin:secretpass@db.example.com/mydb");
      expect(result).toBe("URL credentials");
    });

    it("detects URL credentials with http://", () => {
      const result = detectCredential("http://user:pass@192.168.1.1:8080/api");
      expect(result).toBe("URL credentials");
    });

    it("detects private keys", () => {
      const result = detectCredential("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...");
      expect(result).toBe("Private key");
    });

    it("detects AWS access keys", () => {
      const result = detectCredential("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
      expect(result).toBe("AWS key");
    });

    it("detects GitHub personal access tokens", () => {
      const result = detectCredential("Set GITHUB_TOKEN=ghp_ABCDEFabcdef1234567890");
      expect(result).toBe("GitHub/GitLab token");
    });

    it("detects GitLab tokens", () => {
      const result = detectCredential("Use glpat-xxxxxxxxxxxxxxxxxxxx for auth");
      expect(result).toBe("GitHub/GitLab token");
    });

    it("detects JWT tokens", () => {
      const result = detectCredential(
        "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      );
      expect(result).toBe("JWT");
    });

    it("detects token=value patterns", () => {
      const result = detectCredential(
        "Set token=abcdef1234567890abcdef1234567890ab for authentication",
      );
      expect(result).toBe("Token/secret");
    });

    it("detects secret: value patterns", () => {
      const result = detectCredential(
        "The client secret: abcdef1234567890abcdef1234567890abcdef12",
      );
      expect(result).toBe("Token/secret");
    });
  });

  // --------------------------------------------------------------------------
  // detectCredential() — should NOT flag clean text
  // --------------------------------------------------------------------------

  describe("should not flag clean text", () => {
    it("does not flag normal text", () => {
      expect(detectCredential("Remember to buy groceries tomorrow")).toBeNull();
    });

    it("does not flag password advice (without actual password)", () => {
      expect(
        detectCredential("Make sure the password is at least 8 characters long for security"),
      ).toBeNull();
    });

    it("does not flag discussion about tokens", () => {
      expect(detectCredential("We should use JWT tokens for authentication")).toBeNull();
    });

    it("does not flag short key-like words", () => {
      expect(detectCredential("The key to success is persistence")).toBeNull();
    });

    it("does not flag URLs without credentials", () => {
      expect(detectCredential("Visit https://example.com/api/v1 for docs")).toBeNull();
    });

    it("does not flag discussion about API key rotation", () => {
      expect(detectCredential("Rotate your API keys every 90 days as a best practice")).toBeNull();
    });

    it("does not flag file paths", () => {
      expect(detectCredential("Credentials are stored in /home/user/.secrets/api.json")).toBeNull();
    });

    it("does not flag casual use of slash in text", () => {
      expect(detectCredential("Use the read/write mode for better performance")).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // CREDENTIAL_PATTERNS — structural checks
  // --------------------------------------------------------------------------

  describe("CREDENTIAL_PATTERNS structure", () => {
    it("has at least 8 patterns", () => {
      expect(CREDENTIAL_PATTERNS.length).toBeGreaterThanOrEqual(8);
    });

    it("each pattern has a label and valid RegExp", () => {
      for (const { pattern, label } of CREDENTIAL_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(label).toBeTruthy();
        expect(typeof label).toBe("string");
      }
    });
  });
});

// ============================================================================
// Phase 5b: Paginated credential scan via runSleepCycle
// ============================================================================

/** Build a minimal db mock that passes all phases without errors. */
function makeDb(overrides: Record<string, unknown> = {}): any {
  return {
    findDuplicateClusters: vi.fn().mockResolvedValue([]),
    mergeMemoryCluster: vi.fn().mockResolvedValue({ survivorId: "s1", deletedCount: 0 }),
    findConflictingMemories: vi.fn().mockResolvedValue([]),
    invalidateMemory: vi.fn().mockResolvedValue(undefined),
    reconcileEntityMentionCounts: vi.fn().mockResolvedValue(undefined),
    findDuplicateEntityPairs: vi.fn().mockResolvedValue([]),
    mergeEntityPair: vi.fn().mockResolvedValue(true),
    countByExtractionStatus: vi
      .fn()
      .mockResolvedValue({ pending: 0, complete: 0, failed: 0, skipped: 0 }),
    listPendingExtractions: vi.fn().mockResolvedValue([]),
    listUntaggedMemories: vi.fn().mockResolvedValue([]),
    updateExtractionStatus: vi.fn().mockResolvedValue(undefined),
    findDecayedMemories: vi.fn().mockResolvedValue([]),
    pruneMemories: vi.fn().mockResolvedValue(0),
    fetchMemoriesForTemporalCheck: vi.fn().mockResolvedValue([]),
    findOrphanEntities: vi.fn().mockResolvedValue([]),
    deleteOrphanEntities: vi.fn().mockResolvedValue(0),
    findOrphanTags: vi.fn().mockResolvedValue([]),
    deleteOrphanTags: vi.fn().mockResolvedValue(0),
    findSingleUseTags: vi.fn().mockResolvedValue([]),
    deleteMemoriesByPattern: vi.fn().mockResolvedValue(0),
    // Credential scan methods — overridden per test
    fetchMemoriesForCredentialScan: vi.fn().mockResolvedValue([]),
    deleteMemoriesByIds: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockEmbeddings = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
};

const mockConfig: ExtractionConfig = {
  enabled: false, // disable LLM-dependent phases
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "https://test.ai/api/v1",
  temperature: 0.0,
  maxRetries: 0,
};

describe("Phase 5b: credential scan — paginated batch loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single batch (< 200 memories): fetches once, deletes credential, stops", async () => {
    const cleanMemory = { id: "clean-1", text: "Remember to buy groceries" };
    const credMemory = { id: "cred-1", text: "Use sk-abc123def456ghi789jkl012mno345 for the API" };

    const db = makeDb({
      fetchMemoriesForCredentialScan: vi.fn().mockResolvedValueOnce([cleanMemory, credMemory]),
      deleteMemoriesByIds: vi.fn().mockResolvedValue(1),
    });

    const result = await runSleepCycle(db, mockEmbeddings, mockConfig, mockLogger);

    expect(db.fetchMemoriesForCredentialScan).toHaveBeenCalledTimes(1);
    expect(db.fetchMemoriesForCredentialScan).toHaveBeenCalledWith(0, 200, undefined);
    expect(db.deleteMemoriesByIds).toHaveBeenCalledWith(["cred-1"]);
    expect(result.credentialScan.memoriesScanned).toBe(2);
    expect(result.credentialScan.credentialsFound).toBe(1);
    expect(result.credentialScan.memoriesRemoved).toBe(1);
  });

  it("multiple batches: processes first batch of 200 then second batch of 50", async () => {
    const makeMem = (i: number) => ({ id: `mem-${i}`, text: `Clean memory ${i}` });
    const batch1 = Array.from({ length: 200 }, (_, i) => makeMem(i));
    const batch2 = Array.from({ length: 50 }, (_, i) => makeMem(200 + i));

    const db = makeDb({
      fetchMemoriesForCredentialScan: vi
        .fn()
        .mockResolvedValueOnce(batch1)
        .mockResolvedValueOnce(batch2),
    });

    const result = await runSleepCycle(db, mockEmbeddings, mockConfig, mockLogger);

    expect(db.fetchMemoriesForCredentialScan).toHaveBeenCalledTimes(2);
    expect(db.fetchMemoriesForCredentialScan).toHaveBeenNthCalledWith(1, 0, 200, undefined);
    expect(db.fetchMemoriesForCredentialScan).toHaveBeenNthCalledWith(2, 200, 200, undefined);
    expect(result.credentialScan.memoriesScanned).toBe(250);
    expect(result.credentialScan.credentialsFound).toBe(0);
  });

  it("batch boundary: exactly 200 triggers second fetch; empty second batch stops", async () => {
    const makeMem = (i: number) => ({ id: `mem-${i}`, text: `Clean memory ${i}` });
    const batch1 = Array.from({ length: 200 }, (_, i) => makeMem(i));

    const db = makeDb({
      fetchMemoriesForCredentialScan: vi
        .fn()
        .mockResolvedValueOnce(batch1)
        .mockResolvedValueOnce([]), // empty second page → stop
    });

    const result = await runSleepCycle(db, mockEmbeddings, mockConfig, mockLogger);

    expect(db.fetchMemoriesForCredentialScan).toHaveBeenCalledTimes(2);
    expect(db.fetchMemoriesForCredentialScan).toHaveBeenNthCalledWith(2, 200, 200, undefined);
    expect(result.credentialScan.memoriesScanned).toBe(200);
  });

  it("AbortSignal respected between batches: loop exits after first batch when signal aborted", async () => {
    const controller = new AbortController();
    const makeMem = (i: number) => ({ id: `mem-${i}`, text: `Clean memory ${i}` });
    const batch1 = Array.from({ length: 200 }, (_, i) => makeMem(i));

    const db = makeDb({
      fetchMemoriesForCredentialScan: vi.fn().mockImplementation(async (offset: number) => {
        if (offset === 0) {
          // Abort the signal after returning the first full batch
          controller.abort();
          return batch1;
        }
        return [];
      }),
    });

    await runSleepCycle(db, mockEmbeddings, mockConfig, mockLogger, {
      abortSignal: controller.signal,
    });

    // Only the first fetch should have been called; loop exits on abort check
    expect(db.fetchMemoriesForCredentialScan).toHaveBeenCalledTimes(1);
  });

  it("no credentials found — no memories deleted", async () => {
    const mems = [
      { id: "m1", text: "Normal memory about groceries" },
      { id: "m2", text: "Remember the meeting at 3pm" },
    ];

    const db = makeDb({
      fetchMemoriesForCredentialScan: vi.fn().mockResolvedValueOnce(mems),
      deleteMemoriesByIds: vi.fn(),
    });

    const result = await runSleepCycle(db, mockEmbeddings, mockConfig, mockLogger);

    expect(db.deleteMemoriesByIds).not.toHaveBeenCalled();
    expect(result.credentialScan.credentialsFound).toBe(0);
    expect(result.credentialScan.memoriesRemoved).toBe(0);
  });
});
