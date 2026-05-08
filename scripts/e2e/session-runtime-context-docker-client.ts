// Session runtime-context Docker harness.
// Imports packaged dist modules so transcript behavior is verified against the
// npm tarball installed in the functional image.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  queueRuntimeContextForNextTurn,
  resolveRuntimeContextPromptParts,
} from "../../dist/agents/pi-embedded-runner/run/runtime-context-prompt.js";

type TranscriptEntry = {
  type?: string;
  customType?: string;
  content?: string;
  display?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

async function verifyRuntimeContextTranscriptShape() {
  const entries: TranscriptEntry[] = [];
  const effectivePrompt = [
    "visible ask",
    "",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "secret docker context",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");
  const promptSubmission = resolveRuntimeContextPromptParts({
    effectivePrompt,
    transcriptPrompt: "visible ask",
  });

  assert(promptSubmission.prompt === "visible ask", "visible prompt was not preserved");
  assert(
    promptSubmission.runtimeContext?.includes("secret docker context"),
    "runtime context was not extracted",
  );

  await queueRuntimeContextForNextTurn({
    runtimeContext: promptSubmission.runtimeContext,
    session: {
      sendCustomMessage: async (message, options) => {
        assert(options?.deliverAs === "nextTurn", "runtime context was not queued for next turn");
        entries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
        });
      },
    },
  });
  entries.push({
    type: "message",
    message: {
      role: "user",
      content: promptSubmission.prompt,
    },
  });
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      content: "done",
    },
  });
  const customEntry = entries.find((entry) => entry.type === "custom_message");
  assert(customEntry, "hidden runtime custom message was not persisted");
  assert(customEntry.customType === "openclaw.runtime-context", "unexpected custom message type");
  assert(customEntry.display === false, "runtime custom message should be hidden");
  assert(
    customEntry.content?.includes("secret docker context"),
    "runtime custom message lost context",
  );

  const userEntries = entries.filter((entry) => entry.message?.role === "user");
  assert(userEntries.length === 1, `expected one visible user message, got ${userEntries.length}`);
  const userText = messageText(userEntries[0]?.message?.content);
  assert(userText === "visible ask", `unexpected visible user text: ${JSON.stringify(userText)}`);
  assert(
    !userText.includes("OPENCLAW_INTERNAL_CONTEXT") && !userText.includes("secret docker context"),
    "visible user transcript leaked runtime context",
  );
}

async function seedBrokenLegacySessionForDoctorMigration(stateDir: string): Promise<string> {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const sessionFile = path.join(sessionsDir, "broken.jsonl");
  await fs.mkdir(sessionsDir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id: "broken-session" },
    {
      type: "message",
      id: "parent",
      parentId: null,
      message: { role: "assistant", content: "previous" },
    },
    {
      type: "message",
      id: "runtime-user",
      parentId: "parent",
      message: {
        role: "user",
        content: [
          "visible ask",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret doctor context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
      },
    },
    {
      type: "message",
      id: "runtime-assistant",
      parentId: "runtime-user",
      message: { role: "assistant", content: "stale branch" },
    },
    {
      type: "message",
      id: "plain-user",
      parentId: "parent",
      message: { role: "user", content: "visible ask" },
    },
    {
      type: "message",
      id: "plain-assistant",
      parentId: "plain-user",
      message: { role: "assistant", content: "active answer" },
    },
  ];
  await fs.writeFile(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );
  // This is intentionally a legacy input: the scenario proves doctor imports
  // session indexes and transcript JSONL into SQLite, then removes the sources.
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify(
      {
        "agent:main:qa:docker-runtime-context": {
          sessionId: "broken",
          sessionFile: "broken.jsonl",
          updatedAt: Date.now(),
          displayName: "Docker runtime context repair",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return sessionFile;
}

async function verifyDoctorRepair(root: string) {
  const stateDir = path.join(root, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const sessionFile = await seedBrokenLegacySessionForDoctorMigration(stateDir);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }, null, 2));

  const entry = await fs.stat("dist/index.mjs").then(
    () => "dist/index.mjs",
    () => "dist/index.js",
  );
  const result = spawnSync(process.execPath, [entry, "doctor", "--fix", "--yes", "--force"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    },
    encoding: "utf-8",
    timeout: 120_000,
  });

  assert(
    result.status === 0,
    `doctor --fix failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  await fs.access(sessionFile).then(
    () => {
      throw new Error("doctor left legacy transcript JSONL after SQLite import");
    },
    () => undefined,
  );
  const { loadSqliteSessionTranscriptEvents } =
    (await import("../../dist/config/sessions/transcript-store.sqlite.js")) as typeof import("../../src/config/sessions/transcript-store.sqlite.js");
  const entries = loadSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "broken-session",
  }).map((entry) => entry.event as TranscriptEntry);
  const ids = entries.map((entry) => (entry as { id?: string }).id).filter(Boolean);
  assert(
    JSON.stringify(ids) ===
      JSON.stringify(["broken-session", "parent", "plain-user", "plain-assistant"]),
    `doctor kept wrong active branch: ${JSON.stringify(ids)}`,
  );
  assert(
    entries.every(
      (entry) => !messageText(entry.message?.content).includes("secret doctor context"),
    ),
    "doctor repair left runtime context in active transcript",
  );
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-runtime-context-"));
  process.env.HOME = root;
  process.env.OPENCLAW_STATE_DIR = path.join(root, ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
  try {
    await verifyRuntimeContextTranscriptShape();
    await verifyDoctorRepair(root);
    console.log("session runtime context Docker E2E passed");
  } finally {
    if (process.env.OPENCLAW_SESSION_RUNTIME_CONTEXT_KEEP_ARTIFACTS !== "1") {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.error(`kept artifacts: ${root}`);
    }
  }
}

await main();
