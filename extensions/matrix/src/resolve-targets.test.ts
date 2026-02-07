import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

vi.mock("./directory-live.js", () => ({
  listMatrixDirectoryPeersLive: vi.fn(),
  listMatrixDirectoryGroupsLive: vi.fn(),
}));

describe("resolveMatrixTargets (users)", () => {
  beforeEach(() => {
    vi.mocked(listMatrixDirectoryPeersLive).mockReset();
  });

  it("resolves exact unique display name matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "user", id: "@alice:example.org", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const [result] = await resolveMatrixTargets({
      cfg: {},
      inputs: ["Alice"],
      kind: "user",
    });

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("@alice:example.org");
  });

  it("does not resolve ambiguous or non-exact matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "user", id: "@alice:example.org", name: "Alice" },
      { kind: "user", id: "@alice:evil.example", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const [result] = await resolveMatrixTargets({
      cfg: {},
      inputs: ["Alice"],
      kind: "user",
    });

    expect(result?.resolved).toBe(false);
    expect(result?.note).toMatch(/use full Matrix ID/i);
  });
});
