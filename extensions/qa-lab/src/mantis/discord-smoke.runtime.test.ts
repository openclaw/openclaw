import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuard } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard,
}));

import { runMantisDiscordSmoke } from "./discord-smoke.runtime.js";

const readText = (file: string) => fs.readFile(file, "utf8");

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchGuardCallsWithMethod(method: string) {
  return fetchWithSsrFGuard.mock.calls.filter(([request]) => {
    const init =
      typeof request === "object" && request !== null
        ? (request as { init?: RequestInit }).init
        : undefined;
    return init?.method === method;
  });
}

describe("mantis discord smoke runtime", () => {
  let repoRoot: string;
  let tokenFile: string;

  function mockDiscord({
    listedChannel = "1456744319972282449",
    channelGuild = "1456350064065904867",
    reactionStatus = 204,
  } = {}) {
    fetchWithSsrFGuard.mockImplementation(
      async ({ url, init }: { url: string; init?: RequestInit }) => {
        const pathname = new URL(url).pathname;
        const method = init?.method ?? "GET";
        const routes: Record<string, unknown> = {
          "GET /api/v10/users/@me": { id: "1489650053747314748", username: "Mantis" },
          "GET /api/v10/guilds/1456350064065904867": { id: "1456350064065904867", name: "Friends" },
          "GET /api/v10/guilds/1456350064065904867/channels": [{ id: listedChannel }],
          "GET /api/v10/channels/1456744319972282449": {
            guild_id: channelGuild,
            id: "1456744319972282449",
            name: channelGuild === "1456350064065904867" ? "maintainers" : "wrong-guild-channel",
            type: 0,
          },
          "POST /api/v10/channels/1456744319972282449/messages": {
            id: "1500000000000000001",
            channel_id: "1456744319972282449",
          },
        };
        const reactionPaths = ["%F0%9F%91%80", "👀"].map(
          (emoji) =>
            `/api/v10/channels/1456744319972282449/messages/1500000000000000001/reactions/${emoji}/@me`,
        );
        const payload =
          channelGuild !== "1456350064065904867" && method !== "GET"
            ? undefined
            : routes[`${method} ${pathname}`];
        const response =
          channelGuild === "1456350064065904867" &&
          method === "PUT" &&
          reactionPaths.includes(pathname)
            ? reactionStatus === 204
              ? new Response(null, { status: 204 })
              : jsonResponse({ message: "Missing reaction permission" }, reactionStatus)
            : payload
              ? jsonResponse(payload)
              : jsonResponse({ message: `unexpected ${method} ${pathname}` }, 404);
        return { response, release: vi.fn() };
      },
    );
  }

  function runSmoke(options: NonNullable<Parameters<typeof runMantisDiscordSmoke>[0]>) {
    return runMantisDiscordSmoke({
      repoRoot,
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
      ...options,
    });
  }

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-discord-smoke-"));
    tokenFile = path.join(repoRoot, "mantis-token");
    await fs.writeFile(tokenFile, "test-token", "utf8");
    fetchWithSsrFGuard.mockReset();
    mockDiscord();
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("bounds Mantis Discord token files", async () => {
    await fs.writeFile(tokenFile, "x".repeat(4 * 1024), "utf8");
    const boundaryResult = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/token-boundary",
      skipPost: true,
    });
    expect(boundaryResult.status).toBe("pass");
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
    const fetchCallsAtBoundary = fetchWithSsrFGuard.mock.calls.length;

    await fs.writeFile(tokenFile, "x".repeat(4 * 1024 + 1), "utf8");
    const oversizedResult = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/token-oversized",
      skipPost: true,
    });

    expect(oversizedResult.status).toBe("fail");
    expect(fetchWithSsrFGuard.mock.calls).toHaveLength(fetchCallsAtBoundary);
    expect(await readText(path.join(oversizedResult.outputDir, "error.txt"))).toContain(
      `Mantis Discord token file at ${tokenFile} exceeds 4096 bytes.`,
    );
  });

  it("redacts Discord target metadata in public artifacts", async () => {
    const result = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/redacted",
      redactPublicMetadata: true,
    });

    expect(result.status).toBe("pass");
    const summaryText = await readText(result.summaryPath);
    const reportText = await readText(result.reportPath);
    expect(reportText).toContain("# Mantis Discord Smoke");
    expect(reportText).toContain("- Bot: <redacted> (<redacted>)");
    expect(reportText).toContain("- Guild: <redacted> (<redacted>)");
    expect(reportText).toContain("- Channel: #<redacted> (<redacted>)");
    for (const text of [summaryText, reportText]) {
      expect(text).toContain("<redacted>");
      expect(text).not.toMatch(
        /test-token|1489650053747314748|1456350064065904867|Friends|1456744319972282449|maintainers|1500000000000000001/u,
      );
    }
    expect(summaryText).not.toContain("Mantis");
    expect(JSON.parse(summaryText)).toEqual(
      expect.objectContaining({
        metadataRedaction: true,
        bot: { id: "<redacted>", username: "<redacted>" },
        guild: { id: "<redacted>", name: "<redacted>" },
        channel: { id: "<redacted>", name: "<redacted>", type: 0 },
        message: expect.objectContaining({ id: "<redacted>" }),
      }),
    );
  });

  it.each([false, true])(
    "retains a successful post when its reaction fails (redacted=%s)",
    async (redactPublicMetadata) => {
      mockDiscord({ reactionStatus: 403 });
      const result = await runSmoke({
        outputDir: ".artifacts/qa-e2e/mantis/reaction-failure",
        redactPublicMetadata,
      });

      expect(result.status).toBe("fail");
      const messageId = redactPublicMetadata ? "<redacted>" : "1500000000000000001";
      const summaryText = await readText(result.summaryPath);
      expect(JSON.parse(summaryText).message).toEqual({
        id: messageId,
        posted: true,
        reactionAdded: false,
      });
      const reportText = await readText(result.reportPath);
      expect(reportText).toContain(`- Posted message: ${messageId}`);
      expect(reportText).toContain("- Added reaction: no");
      expect(await readText(path.join(result.outputDir, "error.txt"))).toContain(
        "Missing reaction permission",
      );
      expect(fetchGuardCallsWithMethod("POST")).toHaveLength(1);
      expect(fetchGuardCallsWithMethod("PUT")).toHaveLength(1);
      if (redactPublicMetadata) {
        expect(summaryText + reportText).not.toContain("1500000000000000001");
      }
    },
  );

  it("fails before calling Discord when required ids are missing", async () => {
    const result = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/missing",
      env: {},
    });

    expect(result.status).toBe("fail");
    const errorText = await readText(path.join(result.outputDir, "error.txt"));
    expect(errorText).toContain("Missing OPENCLAW_QA_DISCORD_GUILD_ID");
  });

  it("fails when the channel is not in the configured guild", async () => {
    mockDiscord({ listedChannel: "1999999999999999999", channelGuild: "1999999999999999999" });

    const result = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/wrong-guild",
    });

    expect(result.status).toBe("fail");
    const errorText = await readText(path.join(result.outputDir, "error.txt"));
    expect(errorText).toContain("is not in guild");
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
  });

  it("fails closed when a Discord API response exceeds the byte cap", async () => {
    const oversizedBody = "x".repeat(16 * 1024 * 1024 + 1);
    const release = vi.fn();
    fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v10/users/@me") {
        return {
          response: new Response(oversizedBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          release,
        };
      }
      return {
        response: jsonResponse({ message: `unexpected ${pathname}` }, 404),
        release: vi.fn(),
      };
    });

    const result = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/oversized",
    });

    expect(result.status).toBe("fail");
    const errorText = await readText(path.join(result.outputDir, "error.txt"));
    expect(errorText).toContain("/users/@me response exceeds");
    expect(errorText).toContain(`${16 * 1024 * 1024} bytes`);
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
    expect(release).toHaveBeenCalled();
  });

  it("redacts response guild ids in mismatch failure artifacts", async () => {
    mockDiscord({ channelGuild: "1999999999999999999" });

    const result = await runSmoke({
      outputDir: ".artifacts/qa-e2e/mantis/wrong-guild-redacted",
      redactPublicMetadata: true,
    });

    expect(result.status).toBe("fail");
    const errorText = await readText(path.join(result.outputDir, "error.txt"));
    expect(errorText).toContain("<redacted>");
    expect(errorText).not.toContain("1999999999999999999");
    expect(errorText).not.toContain("1456350064065904867");
    expect(errorText).not.toContain("1456744319972282449");
  });
});
