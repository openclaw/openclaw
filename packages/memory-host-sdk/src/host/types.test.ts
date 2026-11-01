import { describe, expect, it } from "vitest";
import {
  resolveMemoryIndexIdentityDiagnostic,
  resolveMemorySearchStaleness as staleness,
  type MemoryProviderStatus,
} from "./types.js";

const withIdentity = (
  indexIdentity: Record<string, unknown>,
  extra?: Partial<MemoryProviderStatus>,
) => ({
  ...extra,
  custom: { indexIdentity },
});
const mismatch = (reason: string, code: string, owner = "openclaw") => ({
  status: "mismatched",
  reason,
  code,
  owner,
});
const diagnose = (indexIdentity: Record<string, unknown>) =>
  resolveMemoryIndexIdentityDiagnostic(withIdentity(indexIdentity));

describe("memory search staleness", () => {
  it("keeps routine pending index work silent", () => {
    const status: MemoryProviderStatus = {
      backend: "builtin",
      provider: "none",
      dirty: true,
    };
    expect(staleness(status)).toBeNull();
  });

  it("reports the latest automatic sync failure", () => {
    expect(staleness({ lastSyncError: "embedding request timed out" }, "main")).toEqual({
      stale: true,
      warning:
        "Memory index is stale: embedding request timed out. Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it("gives an incompatible index identity precedence over a sync failure", () => {
    expect(
      staleness(
        withIdentity(mismatch("embedding model changed", "model", "configuration"), {
          lastSyncError: "embedding request timed out",
        }),
      ),
    ).toMatchObject({ warning: expect.stringContaining("embedding model changed") });
  });

  it("reports the failed repair prerequisite while the embedding format is still incompatible", () => {
    expect(
      staleness(
        withIdentity(mismatch("runtime format changed", "embedding_input_format"), {
          lastSyncError: "HTTP 400: embedding provider unavailable",
        }),
        "main",
      ),
    ).toEqual({
      stale: true,
      warning:
        "Memory index repair failed: HTTP 400: embedding provider unavailable. The existing index was left unchanged.",
      action:
        "Run: openclaw memory status --deep --agent main. Resolve the reported sync failure before retrying the search.",
    });
  });

  it("keeps newer-index recovery visible after a prior sync failure", () => {
    const status: MemoryProviderStatus = {
      backend: "builtin",
      provider: "openai",
      lastSyncError: "HTTP 400: embedding provider unavailable",
      ...withIdentity({
        ...mismatch(
          "the index was written by a newer OpenClaw version; upgrade OpenClaw or reindex explicitly",
          "embedding_input_format",
        ),
        versionOrder: "newer",
      }),
    };
    const result = staleness(status, "main");
    expect(result?.warning).toContain("newer OpenClaw version");
    expect(result?.warning).toContain("Previous memory sync failed: HTTP 400");
    expect(result?.action).toContain("Upgrade OpenClaw or reindex explicitly");
    expect(result?.action).toContain("provider cost");
    expect(status.lastSyncError).toBe("HTTP 400: embedding provider unavailable");
  });

  it("attributes an OpenClaw-owned format mismatch and names the repair cost", () => {
    const status: MemoryProviderStatus = {
      backend: "builtin",
      provider: "openai",
      ...withIdentity(mismatch("index provenance classifier changed", "provenance_version")),
    };
    expect(resolveMemoryIndexIdentityDiagnostic(status)).toEqual({
      status: "mismatched",
      reason: "index provenance classifier changed",
      code: "provenance_version",
      owner: "openclaw",
    });
    expect(staleness(status, "main")).toEqual({
      stale: true,
      warning:
        "Memory index is stale: index provenance classifier changed (owner: openclaw, code: provenance_version). Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it.each([
    ["chunking_version", "chunkingVersionOnly", "index chunking implementation changed"],
    ["embedding_input_format", "lexicalCompatible", "index embedding input format changed"],
  ])("preserves %s compatibility only for a pending upgrade", (code, flag, reason) => {
    const base = mismatch(reason, code);
    expect(diagnose({ ...base, [flag]: true })).toEqual({ ...base, [flag]: true });
    expect(diagnose({ ...base, versionOrder: "newer", [flag]: true })).toEqual(base);
    if (flag === "chunkingVersionOnly") {
      expect(diagnose(base)).toEqual(base);
    } else {
      expect(diagnose({ ...base, code: "provenance_version", [flag]: true })).toEqual({
        ...base,
        code: "provenance_version",
      });
    }
  });

  it("does not claim provider cost for a keyword-only index", () => {
    expect(
      staleness(
        withIdentity(mismatch("index sources changed", "sources", "configuration"), {
          provider: "none",
          requestedProvider: "none",
        }),
        "main",
      ),
    ).toEqual({
      stale: true,
      warning:
        "Memory index is stale: index sources changed (owner: configuration, code: sources). Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.",
    });
  });

  it.each([
    mismatch("invalid owner for code", "provider"),
    {
      status: "missing",
      reason: "invalid missing state",
      code: "metadata_missing",
      owner: "configuration",
    },
  ])("rejects malformed identity diagnostic %#", (indexIdentity) => {
    expect(diagnose(indexIdentity)).toBeUndefined();
  });
});
