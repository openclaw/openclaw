import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as gateway from "openclaw/plugin-sdk/gateway-runtime";
import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importGrokBots, installConvertedPackage } from "./import.js";

const temporary: string[] = [];
const recipe = {
  profile: { name: "Research Bot", description: "Only report verified evidence." },
  skills: [{ name: "research", description: "Research sources", content: "Read primary sources." }],
  memory: [],
  routines: [],
  plugins: [],
};
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "grok-import-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Grok import operations", () => {
  it("converts an offline recipe without accessing the user's account", async () => {
    const root = await directory();
    const source = join(root, "recipe.json");
    await writeFile(source, JSON.stringify(recipe));
    const auth = vi.fn();
    const results = await importGrokBots({
      source,
      out: join(root, "claw"),
      resolveAccessToken: auth,
    });
    expect(auth).not.toHaveBeenCalled();
    expect(results).toMatchObject([
      { name: "Research Bot", status: "converted", conversion: { counts: { skills: 1 } } },
    ]);
    expect(await readFile(results[0]!.conversion!.manifestPath, "utf8")).toContain(
      recipe.profile.description,
    );
  });

  it("preserves the converted package when native installation is blocked", async () => {
    const root = await directory();
    const source = join(root, "recipe.json");
    await writeFile(source, JSON.stringify(recipe));
    vi.spyOn(gateway, "isImplicitLocalGatewayTargetFromCli").mockResolvedValue(true);
    const rpc = vi
      .spyOn(gateway, "callGatewayFromCli")
      .mockResolvedValue({ blockers: [{ code: "labs_disabled" }] });
    const results = await importGrokBots({
      source,
      out: join(root, "claw"),
      install: true,
      resolveAccessToken: vi.fn(),
    });
    expect(results).toMatchObject([
      {
        status: "failed",
        error: expect.stringContaining("labs_disabled"),
        conversion: { counts: { skills: 1 } },
      },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await readFile(results[0]!.conversion!.manifestPath, "utf8")).toContain(
      recipe.profile.description,
    );
  });

  it("installs a transferred package using the reviewed native plan integrity", async () => {
    vi.spyOn(gateway, "isImplicitLocalGatewayTargetFromCli").mockResolvedValue(true);
    const rpc = vi
      .spyOn(gateway, "callGatewayFromCli")
      .mockResolvedValueOnce({ planIntegrity: "sha256:plan", blockers: [] })
      .mockResolvedValueOnce({ status: "complete", agentId: "research-bot" });
    expect(await installConvertedPackage("/tmp/research-claw", {})).toBe("research-bot");
    expect(rpc.mock.calls.map(([method, , params]) => ({ method, params }))).toEqual([
      { method: "claws.add.plan", params: { source: { localPath: "/tmp/research-claw" } } },
      {
        method: "claws.add.apply",
        params: { source: { localPath: "/tmp/research-claw" }, planIntegrity: "sha256:plan" },
      },
    ]);
  });

  it("reports the native partial-install error and retains the package without claiming installation", async () => {
    const root = await directory();
    const source = join(root, "recipe.json");
    await writeFile(source, JSON.stringify(recipe));
    vi.spyOn(gateway, "isImplicitLocalGatewayTargetFromCli").mockResolvedValue(true);
    const rpc = vi
      .spyOn(gateway, "callGatewayFromCli")
      .mockResolvedValueOnce({ planIntegrity: "sha256:plan", blockers: [] })
      .mockResolvedValueOnce({
        status: "partial",
        agentId: "research-bot",
        readiness: { ready: false, requirements: [] },
        error: {
          code: "agent_create_failed",
          message: "Agent deletion journal is unavailable. Run openclaw doctor to repair it.",
        },
      });
    const results = await importGrokBots({
      source,
      out: join(root, "claw"),
      install: true,
      resolveAccessToken: vi.fn(),
    });
    expect(results).toMatchObject([
      {
        name: "Research Bot",
        status: "failed",
        conversion: { counts: { skills: 1 } },
        error: expect.stringContaining("Run openclaw doctor to repair it."),
      },
    ]);
    expect(results[0]?.agentId).toBeUndefined();
    expect(results[0]?.error).toContain("Inspect the agent list before retrying");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(await readFile(results[0]!.conversion!.manifestPath, "utf8")).toContain(
      recipe.profile.description,
    );
  });

  it.each([
    "https://user:synthetic-secret@x.ai/bot/abc",
    "https://x.ai/bot/abc?token=synthetic-secret",
  ])("rejects unsafe source URLs before account access or result creation: %s", async (source) => {
    const auth = vi.fn();
    const result = importGrokBots({
      source,
      out: join(await directory(), "claw"),
      resolveAccessToken: auth,
    });
    await expect(result).rejects.toThrow(/^Expected a Grok Bot/);
    await expect(result).rejects.not.toThrow("synthetic-secret");
    expect(auth).not.toHaveBeenCalled();
  });

  it("never sends a local source path to a configured remote gateway", async () => {
    vi.spyOn(gateway, "isImplicitLocalGatewayTargetFromCli").mockResolvedValue(false);
    const rpc = vi.spyOn(gateway, "callGatewayFromCli");
    await expect(installConvertedPackage("/tmp/research-claw", {})).rejects.toThrow(
      "gateway machine",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "exports nothing when Grok rejects account access with HTTP %s",
    async (status) => {
      const root = await directory();
      const fetch = vi.spyOn(network, "fetchWithSsrFGuard").mockResolvedValue({
        response: new Response(null, { status }),
        release: async () => {},
        finalUrl: "https://api2.cursor.sh",
      });
      const rpc = vi.spyOn(gateway, "callGatewayFromCli").mockResolvedValue({});
      await expect(
        importGrokBots({
          all: true,
          out: join(root, "export"),
          install: true,
          resolveAccessToken: async () => "synthetic-rejected-token",
        }),
      ).rejects.toThrow(status === 401 ? "Grok access is required" : "Grok refused access");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0].url).toBe(
        "https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgents",
      );
      expect(await readdir(root)).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("exports only readable owned bots, excluding teammates and preserving equal names", async () => {
    const root = await directory();
    const auth = vi.fn(async () => "synthetic-token");
    const requestedAgentIds: unknown[] = [];
    const ownerRow = (id: string) => ({
      id,
      agentId: id,
      name: "Same Name",
      description: id,
      kind: "GROK_BOT_AGENT_KIND_AGENT",
      visibility: "GROK_BOT_AGENT_VISIBILITY_OWNER",
    });
    vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async (request) => {
      const method = new URL(request.url).pathname.split("/").at(-1);
      if (typeof request.init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      const body = JSON.parse(request.init.body);
      if (body.agentId !== undefined) {
        requestedAgentIds.push(body.agentId);
      }
      const reply =
        method === "ListGrokBotAgents"
          ? {
              agents: [
                ...["first", "broken", "last"].map(ownerRow),
                { ...ownerRow("teammate"), visibility: "GROK_BOT_AGENT_VISIBILITY_TEAM" },
                { ...ownerRow("room"), kind: "GROK_BOT_AGENT_KIND_ROOM" },
                { ...ownerRow("not-owner"), viewerIsOwner: false },
              ],
            }
          : method === "ListGrokBotAgentSkills"
            ? { skills: [] }
            : method === "ListGrokBotAgentAutomations"
              ? { automations: [] }
              : { serviceAccountsEnabled: false };
      return {
        response:
          body.agentId === "broken" ? new Response(null, { status: 403 }) : Response.json(reply),
        release: async () => {},
        finalUrl: request.url,
      };
    });
    const results = await importGrokBots({ all: true, out: root, resolveAccessToken: auth });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(["converted", "failed", "converted"]);
    expect(new Set(requestedAgentIds)).toEqual(new Set(["broken", "first", "last"]));
    expect(results[1]?.conversion).toBeUndefined();
    expect(results[1]?.error).toContain("Grok refused access");
    expect((await readdir(root)).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [results[0]!, results[2]!]
        .map((result) => basename(result.conversion!.packageRoot))
        .toSorted((a, b) => a.localeCompare(b)),
    );
    for (const result of [results[0]!, results[2]!]) {
      expect(result.conversion?.completeness).toBe("partial");
      expect(result.conversion?.warnings.map(({ code }) => code)).toEqual([
        "source_memory_unavailable",
        "source_integration_requirements_unavailable",
      ]);
    }
    const manifests = await Promise.all(
      [results[0]!, results[2]!].map((result) => readFile(result.conversion!.manifestPath, "utf8")),
    );
    expect(manifests[0]?.match(/ {2}id: (.+)/)?.[1]).not.toBe(
      manifests[1]?.match(/ {2}id: (.+)/)?.[1],
    );
  });
});
