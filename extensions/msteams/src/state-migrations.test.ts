import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { loadSessionLearnings } from "./feedback-reflection-store.js";
import { getPendingUploadState } from "./pending-uploads-state.js";
import { createMSTeamsPollStoreState } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStore } from "./sso-token-store.js";
import { detectMSTeamsLegacyStateMigrations } from "./state-migrations.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
  setMSTeamsRuntime(msteamsRuntimeStub);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-msteams-migrate-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setMSTeamsRuntime(msteamsRuntimeStub);
  return stateDir;
}

async function applyPlan(stateDir: string, label: string) {
  const plan = detectMSTeamsLegacyStateMigrations({ stateDir }).find(
    (entry) => entry.label === label,
  );
  if (!plan || plan.kind !== "custom") {
    throw new Error(`missing MSTeams migration plan: ${label}`);
  }
  return await plan.apply({
    cfg: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
  });
}

describe("Microsoft Teams legacy state migrations", () => {
  it("imports conversation and poll files into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const conversationFile = path.join(stateDir, "msteams-conversations.json");
    const pollFile = path.join(stateDir, "msteams-polls.json");
    fs.writeFileSync(
      conversationFile,
      `${JSON.stringify({
        version: 1,
        conversations: {
          "conv-1": {
            conversation: { id: "conv-1", conversationType: "personal" },
            channelId: "msteams",
            serviceUrl: "https://service.example.com",
            user: { id: "user-1" },
            lastSeenAt: "2026-03-25T20:00:00.000Z",
          },
        },
      })}\n`,
    );
    fs.writeFileSync(
      pollFile,
      `${JSON.stringify({
        version: 1,
        polls: {
          "poll-1": {
            id: "poll-1",
            question: "Lunch?",
            options: ["Pizza", "Sushi"],
            maxSelections: 1,
            createdAt: new Date().toISOString(),
            votes: {},
          },
        },
      })}\n`,
    );

    await applyPlan(stateDir, "Microsoft Teams conversation");
    await applyPlan(stateDir, "Microsoft Teams poll");

    await expect(createMSTeamsConversationStoreState().get("conv-1")).resolves.toMatchObject({
      conversation: { id: "conv-1" },
    });
    await expect(createMSTeamsPollStoreState().getPoll("poll-1")).resolves.toMatchObject({
      question: "Lunch?",
    });
    expect(fs.existsSync(conversationFile)).toBe(false);
    expect(fs.existsSync(pollFile)).toBe(false);
  });

  it("imports pending uploads into SQLite plugin blobs", async () => {
    const stateDir = makeStateDir();
    const uploadFile = path.join(stateDir, "msteams-pending-uploads.json");
    fs.writeFileSync(
      uploadFile,
      `${JSON.stringify({
        version: 1,
        uploads: {
          "upload-1": {
            id: "upload-1",
            bufferBase64: Buffer.from("payload").toString("base64"),
            filename: "payload.txt",
            contentType: "text/plain",
            conversationId: "conv-1",
            createdAt: Date.now(),
          },
        },
      })}\n`,
    );

    await applyPlan(stateDir, "Microsoft Teams pending upload");

    const loaded = await getPendingUploadState("upload-1");
    expect(loaded?.filename).toBe("payload.txt");
    expect(loaded?.buffer.toString("utf8")).toBe("payload");
    expect(fs.existsSync(uploadFile)).toBe(false);
  });

  it("imports SSO token files into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const tokenFile = path.join(stateDir, "msteams-sso-tokens.json");
    fs.writeFileSync(
      tokenFile,
      `${JSON.stringify({
        version: 1,
        tokens: {
          "legacy::wrong-key": {
            connectionName: "conn",
            userId: "user-1",
            token: "token-1",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        },
      })}\n`,
    );

    await applyPlan(stateDir, "Microsoft Teams SSO token");

    await expect(
      createMSTeamsSsoTokenStore({ stateDir }).get({
        connectionName: "conn",
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      token: "token-1",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it("imports feedback learning files into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const learningFile = path.join(stateDir, "bXN0ZWFtczp1c2VyMQ.learnings.json");
    fs.writeFileSync(learningFile, `${JSON.stringify(["Use bullets"])}\n`);

    await applyPlan(stateDir, "Microsoft Teams feedback learning");

    await expect(loadSessionLearnings("msteams:user1")).resolves.toEqual(["Use bullets"]);
    expect(fs.existsSync(learningFile)).toBe(false);
  });
});
