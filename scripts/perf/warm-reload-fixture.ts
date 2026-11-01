// Offline synthetic state; the caller owns the new directory and Gateway lifecycle.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";
import type { startWarmReloadAdmission } from "./warm-reload-admission.ts";

type RequestGateway = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type WarmReloadFixtureOptions = {
  stateDir: string;
  port: number;
  uiRoot?: string;
  sessions?: number;
  transcriptLatePaint?: boolean;
  admission?: Pick<
    Awaited<ReturnType<typeof startWarmReloadAdmission>>,
    "origin" | "gatewayAuth" | "viewerEmail" | "peerSessions"
  >;
};

function transcript(
  session: number,
  now: number,
  imageBlocks: readonly unknown[],
  agentId: string,
  longMarkdown = false,
) {
  const events: unknown[] = [];
  let parentId: string | null = null;
  let sequence = 0;
  const append = (message: Record<string, unknown>, suffix: string) => {
    const id = `warm-proof-${session}-${suffix}`;
    const timestamp = now - 60_000 + sequence++ * 1000;
    events.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: { ...message, timestamp },
    });
    parentId = id;
  };
  for (let row = 0; row < 9; row++) {
    const runId = `warm-proof-run-${session}-${row}`;
    append(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Check synthetic milestone ${row + 1} and retain the complete result.`,
          },
        ],
        __openclaw: {
          senderIdentity: "profile:team-shape-profile-0",
          senderName: "Synthetic teammate 0",
          runId,
        },
      },
      `user-${row}`,
    );
    if (row === 8) {
      append(
        {
          role: "assistant",
          runId,
          content: [
            {
              type: "toolCall",
              id: "warm-proof-read",
              name: "read",
              arguments: { path: "fixture.md" },
            },
          ],
        },
        "tool-call",
      );
      append(
        {
          role: "toolResult",
          runId,
          toolCallId: "warm-proof-read",
          toolName: "read",
          content: [
            {
              type: "text",
              text: "Synthetic verification output: 9 milestones checked, no live account accessed.",
            },
          ],
          activity: [
            {
              itemId: "tool:warm-proof-read",
              toolCallId: "warm-proof-read",
              kind: "tool",
              phase: "end",
              name: "read",
              title: "Read fixture",
              status: "completed",
            },
          ],
        },
        "tool-result",
      );
    }
    const table = [
      "| Check | State | Owner | Evidence |",
      "| --- | --- | --- | --- |",
      ...Array.from(
        { length: row === 8 ? 42 : 8 },
        (_, index) =>
          `| Milestone ${index + 1} | Complete | Fixture team | Synthetic result ${row + 1}.${index + 1} |`,
      ),
    ].join("\n");
    const code = [
      "```typescript",
      ...Array.from(
        { length: row === 8 ? 28 : 8 },
        (_, index) =>
          `const checkpoint${index + 1} = { ready: true, sample: ${row * 100 + index} };`,
      ),
      "```",
    ].join("\n");
    append(
      {
        role: "assistant",
        model: "gpt-4.1",
        runId,
        stopReason: "stop",
        usage: { input: 1200, output: 600, totalTokens: 1800 },
        content: [
          {
            type: "text",
            text: [
              `### Synthetic milestone ${row + 1}`,
              "This is synthetic reload-proof data. The checks below exercise tall rows, tables, code, and retained layout while live authority reconnects.",
              table,
              code,
              ...(longMarkdown
                ? Array.from(
                    { length: 24 },
                    (_, index) =>
                      `- **Verification ${index + 1}** retains the complete synthetic result.\n  - The nested item links to [fixture evidence](https://example.invalid/verification/${index + 1}) and preserves its layout on reload.`,
                  )
                : []),
              `[Related fixture session](/chat/${agentId}/team-shape-session-2) · [Synthetic pull request](https://github.com/openclaw-fixture/reload-proof/pull/248)`,
            ].join("\n\n"),
          },
          ...(row === 8 ? imageBlocks : []),
        ],
      },
      `assistant-${row}`,
    );
    if (row === 7) {
      const id = `warm-proof-${session}-notice`;
      events.push({
        type: "custom_message",
        id,
        parentId,
        timestamp: new Date(now - 60_000 + sequence++ * 1000).toISOString(),
        customType: "notice",
        content:
          "Synthetic checkpoint: the next result includes the attached chart and final verification.",
        display: true,
      });
      parentId = id;
    }
  }
  return events;
}

/** Refuses existing state and seeds through the existing offline benchmark/storage owners. */
export async function seedWarmReloadFixture(options: WarmReloadFixtureOptions) {
  if (!Number.isInteger(options.port) || options.port < 19600 || options.port > 19699) {
    throw new Error("Warm-reload Gateway port must be between 19600 and 19699");
  }
  const sessions = options.sessions ?? 3000;
  if (!Number.isSafeInteger(sessions) || sessions < 2000) {
    throw new Error("Warm-reload fixture requires at least 2000 sessions");
  }
  const stateDir = path.resolve(options.stateDir);
  const agentId = "reviewer";
  const workspaceDir = path.join(stateDir, "workspace", agentId);
  const worktreeLocal = path.resolve(".local");
  if (!stateDir.startsWith(`${worktreeLocal}${path.sep}`)) {
    throw new Error("Fixture state must be a new directory inside this worktree's .local/");
  }
  const now = Date.now();
  const sidebarGroups = Array.from(
    { length: 97 },
    (_, index) => `Synthetic group ${String(index + 1).padStart(2, "0")}`,
  );
  const sidebarSectionOrder = [
    "work",
    "groups",
    "ungrouped",
    "catalog:cron",
    "catalog:terminal",
    ...sidebarGroups.map((name) => `category:${name}`),
  ];
  let viewerId: string;
  let pinKeys: string[];
  let sidebarParents: Array<{ key: string; childKeys: string[] }>;
  const sessionKeys = [
    `agent:${agentId}:dashboard:24800000-0000-4000-8000-000000000001`,
    `agent:${agentId}:dashboard:24800001-0000-4000-8000-000000000001`,
  ];
  const baseOptions = parseTeamShapeOptions([
    "--state-dir",
    stateDir,
    "--sessions",
    String(sessions),
    "--agents",
    "2",
    "--runs",
    "11",
    "--settled-runs",
    "--approvals",
    "0",
    "--cron",
    "8",
    "--cron-announce-last",
    "--projects",
    "0",
    "--transcript-mib",
    "0",
    "--now",
    String(now),
  ]);
  const fixture = await generateTeamShapeFixture({
    ...baseOptions,
    agentId,
    port: options.port,
    sessionKeys,
  });
  const configPath = path.join(stateDir, "openclaw.json");
  const token = randomUUID();
  const env = {
    ...fixture.env,
    USER: "synthetic-fixture",
    LOGNAME: "synthetic-fixture",
    OPENAI_API_KEY: "synthetic-loopback-provider-key",
    ...(options.admission
      ? { OPENCLAW_GATEWAY_PASSWORD: options.admission.gatewayAuth.password }
      : {}),
  };
  const previousEnv = process.env;
  let stopMock: (() => Promise<void>) | undefined;
  try {
    process.env = { ...env };
    const { startQaMockOpenAiServer } =
      await import("../../extensions/qa-lab/src/providers/mock-openai/server.js");
    const mock = await startQaMockOpenAiServer();
    stopMock = () => mock.stop();
    const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    applyMockOpenAiModelConfig(config, {
      mockPort: Number(new URL(mock.baseUrl).port),
      modelRef: "openai/gpt-4.1",
    });
    config.gateway = {
      ...config.gateway,
      port: options.port,
      auth: options.admission?.gatewayAuth ?? { mode: "token", token },
      ...(options.admission ? { trustedProxies: ["127.0.0.1"] } : {}),
      controlUi: {
        enabled: true,
        ...(options.admission ? { allowedOrigins: [options.admission.origin] } : {}),
        ...(options.uiRoot ? { root: path.resolve(options.uiRoot) } : {}),
      },
    };
    config.models = { ...config.models, catalogRefresh: { enabled: false } };
    config.plugins = { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } };
    config.agents = {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        modelPolicy: { allow: ["openai/*"] },
        systemAgent: { agentId: "main" },
      },
      entries: {
        ...config.agents?.entries,
        [agentId]: {
          ...config.agents?.entries?.[agentId],
          workspace: workspaceDir,
          identity: { name: "Harbor proof assistant", emoji: "⚓", avatar: "avatar.png" },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const [
      agentDb,
      stateDb,
      entries,
      transcripts,
      reactions,
      progress,
      profiles,
      images,
      png,
      cronLoad,
      cronSave,
      cronKey,
      profileWrites,
      owners,
      preferences,
    ] = await Promise.all([
      import("../../src/state/openclaw-agent-db.js"),
      import("../../src/state/openclaw-state-db.js"),
      import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
      import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
      import("../../src/config/sessions/session-reaction-store.kernel.js"),
      import("../../src/session-cards/progress-card-store.js"),
      import("../../src/state/user-profiles.js"),
      import("../../src/gateway/managed-image-attachments.js"),
      import("../../src/plugin-sdk/test-helpers/image-fixtures.js"),
      import("../../src/cron/store/load.kernel.js"),
      import("../../src/cron/store/save.kernel.js"),
      import("../../src/cron/store/key.js"),
      import("../../src/state/user-profile-writes.js"),
      import("../../src/config/sessions/session-accessor.sqlite-owner.js"),
      import("../../src/state/user-preferences.js"),
    ]);
    const database = { agentId, env };
    const targets = [0, 1].map((index) => ({
      key: sessionKeys[index]!,
      id: `team-shape-session-${index}`,
      label: index === 0 ? "Warm reload verification" : "Reload proof dashboard",
    }));
    let assignedToOperator = 0;
    let activeAssignedToOperator = 0;
    try {
      const avatar = png.createSolidPngBuffer(96, 96, { r: 33, g: 108, b: 140 });
      writeFileSync(path.join(workspaceDir, "avatar.png"), avatar);
      writeFileSync(
        path.join(workspaceDir, "README.md"),
        "# Synthetic reload-proof workspace\n\nOnly generated fixture data is retained here.\n",
      );
      const gitEnv = {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Synthetic Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Synthetic Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: new Date(now).toISOString(),
        GIT_COMMITTER_DATE: new Date(now).toISOString(),
      };
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", workspaceDir, ...args], { env: gitEnv, stdio: "ignore" });
      git("init", "--initial-branch=main");
      git("add", "README.md", "avatar.png");
      git("-c", "commit.gpgSign=false", "commit", "-m", "test: seed synthetic reload workspace");
      const gatewayOwner = profiles.ensureGatewayOwnerProfile("Synthetic proof operator", { env });
      await profileWrites.setCanonicalUserProfileAvatar(gatewayOwner.id, avatar, "image/png", {
        env,
      });
      const viewer = options.admission
        ? await profileWrites.ensureCanonicalUserProfileForEmail(options.admission.viewerEmail, {
            env,
          })
        : gatewayOwner;
      viewerId = viewer.id;
      if (options.admission) {
        await profileWrites.setCanonicalUserProfileDisplayName(
          viewer.id,
          "Synthetic proof operator",
          { env },
        );
        await profileWrites.setCanonicalUserProfileAvatar(viewer.id, avatar, "image/png", { env });
        for (const [index, peer] of options.admission.peerSessions.entries()) {
          const profile = await profileWrites.ensureCanonicalUserProfileForEmail(peer.email, {
            env,
          });
          await profileWrites.setCanonicalUserProfileDisplayName(
            profile.id,
            `Synthetic viewer ${index + 1}`,
            { env },
          );
          await profileWrites.setCanonicalUserProfileAvatar(
            profile.id,
            png.createSolidPngBuffer(40, 40, { r: 55 + index * 60, g: 135, b: 185 - index * 40 }),
            "image/png",
            { env },
          );
        }
      }
      stateDb.runOpenClawStateWriteTransaction(
        (owner) => {
          const storeKey = cronKey.cronStoreKey(path.join(stateDir, "cron", "jobs.json"));
          const { store } = cronLoad.loadCronStoreFromDatabase(owner.db, storeKey);
          for (const [index, job] of store.jobs.entries()) {
            job.sessionKey = targets[index % 2]!.key;
          }
          cronSave.saveCronStoreInDatabase(owner, storeKey, store);
        },
        { env },
      );
      for (const [index, target] of targets.entries()) {
        agentDb.runOpenClawAgentWriteTransaction((owner) => {
          const old = entries.readExactSessionEntryRow(owner, target.key);
          if (!old) {
            throw new Error(`Missing generated fixture session ${target.key}`);
          }
          entries.writeSessionEntry(
            owner,
            target.key,
            {
              ...old.entry,
              label: target.label,
              displayName: target.label,
              archivedAt: now - 1000,
              pinnedAt: now - index,
              updatedAt: now - index,
              lastActivityAt: now - index,
              boardFace: index === 1 ? "dashboard" : "chat",
              status: "done",
            },
            { canonicalPreviousEntry: old.entry, canonicalPreviousRow: old.row },
          );
        }, database);
        const imageId = `warm-proof-${index}-assistant-8`;
        const imageBlocks = await images.createManagedOutgoingMediaBlocks({
          sessionKey: target.key,
          agentId,
          stateDir,
          messageId: imageId,
          items: [
            {
              url: `data:image/png;base64,${png.createSolidPngBuffer(960, 400, { r: 44, g: 122, b: 110 }).toString("base64")}`,
              trustedLocal: false,
            },
          ],
        });
        agentDb.runOpenClawAgentWriteTransaction((owner) => {
          transcripts.appendTranscriptEventsInTransaction(
            owner,
            {
              ...database,
              sessionKey: target.key,
              sessionId: target.id,
            },
            transcript(index, now, imageBlocks, agentId, options.transcriptLatePaint),
          );
          reactions.setSessionReactionInDatabase(owner, target.key, {
            expectedSessionId: target.id,
            messageId: imageId,
            emoji: "✅",
            identityId: "team-shape-profile-0",
            identityLabel: "Synthetic teammate 0",
          });
          progress.writeSessionProgressCard(owner.db, target.key, {
            markdown: "Synthetic reload verification is in progress.",
            steps: [
              { step: "Prepare isolated fixture", status: "completed" },
              { step: "Inspect frame-by-frame reload", status: "in_progress" },
              { step: "Record baseline evidence", status: "pending" },
            ],
          });
        }, database);
      }
      const targetKeys = new Set(targets.map((target) => target.key));
      const inventory = Object.entries(
        entries.readSessionEntryStore(agentDb.openOpenClawAgentDatabase(database)),
      );
      pinKeys = inventory.slice(2, 4).map(([key]) => key);
      const retainedParents = new Map<string, string[]>();
      for (const [key, entry] of inventory) {
        if (entry.spawnedBy) {
          const children = retainedParents.get(entry.spawnedBy) ?? [];
          children.push(key);
          retainedParents.set(entry.spawnedBy, children);
        }
      }
      sidebarParents = [...retainedParents].flatMap(([key, childKeys]) =>
        targetKeys.has(key) || pinKeys.includes(key) ? [] : [{ key, childKeys }],
      );
      const parentKeys = new Set(sidebarParents.map(({ key }) => key));
      const childKeys = new Set([...retainedParents.values()].flat());
      for (let offset = 0; offset < inventory.length; offset += 100) {
        agentDb.runOpenClawAgentWriteTransaction((owner) => {
          for (let index = offset; index < Math.min(offset + 100, inventory.length); index++) {
            const [key, entry] = inventory[index]!;
            const old = entries.readExactSessionEntryRow(owner, key);
            if (!old) {
              throw new Error("Missing synthetic sidebar session");
            }
            const parent = parentKeys.has(key);
            const child = childKeys.has(key);
            const unarchived = index === 2 || index === 3 || parent || child;
            const category = index % sidebarGroups.length;
            entries.writeSessionEntry(
              owner,
              key,
              {
                ...old.entry,
                // The first expanded category contains the real retained-run parent cohort.
                category: child
                  ? undefined
                  : sidebarGroups[parent ? 5 : category === 5 ? 6 : category],
                ...(parent
                  ? {
                      updatedAt: now - index,
                      lastActivityAt: now - index,
                      lastInteractionAt: now - index,
                    }
                  : {}),
                ...(unarchived ? { archivedAt: undefined } : {}),
              },
              { canonicalPreviousEntry: old.entry, canonicalPreviousRow: old.row },
            );
            if (
              index % 10 === 0 &&
              !targetKeys.has(key) &&
              !parentKeys.has(key) &&
              !childKeys.has(key)
            ) {
              continue;
            }
            owners.replaceSessionOwnerInTransaction(owner, key, {
              actor: { type: "human", id: viewer.id },
              assignedBy: { type: "human", id: viewer.id },
              assignedAt: now,
            });
            assignedToOperator++;
            if (unarchived || !entry.archivedAt) {
              activeAssignedToOperator++;
            }
          }
        }, database);
      }
      const pinned = await preferences.setCanonicalUserPreferences(
        viewer.id,
        { "ui.railShortcuts": pinKeys.map((key) => `session:${key}`) },
        { env },
      );
      if (!pinned?.ok) {
        throw new Error("Unable to seed synthetic personal sidebar pins");
      }
    } finally {
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
    }
    const fixtureSummary = {
      ...fixture.summary,
      format: "openclaw-warm-reload-fixture-v1",
      sessions,
      assignedToOperator,
      activeAssignedToOperator,
      workspaceGitBranch: "main",
      assistantRowsPerRoute: 9,
      largestTableRows: 42,
      largestCodeLines: 28,
      managedImagePerRoute: 1,
      reactionsPerRoute: 1,
      noticeRowsPerRoute: 1,
      mockProvider: "QA loopback OpenAI Responses",
      admission: options.admission ? "signed-in" : "token",
      otherViewers: options.admission?.peerSessions.length ?? 0,
      targets,
      viewerId,
      pinKeys,
      sidebarParents,
      sidebarShape: {
        agentId,
        defaultAgentId: "main",
        owner: "involving-me",
        grouping: "category",
        sort: "created",
        groups: sidebarGroups.length,
        sectionOrder: sidebarSectionOrder.length,
        collapsed: 5,
        emptyGroups: "always",
        preview: false,
        archivedTargets: true,
        nonArchivedPins: 2,
        expandedRetainedParents: sidebarParents.length,
      },
      ...(options.transcriptLatePaint
        ? {
            transcriptLatePaint: {
              archivedTargets: true,
              groups: sidebarGroups,
              sectionOrder: sidebarSectionOrder,
              collapsedSections: sidebarGroups.slice(0, 5).map((name) => `category:${name}`),
              ownerFilter: "involving-me",
              grouping: "category",
              sort: "created",
              emptyGroups: "always",
              preview: false,
            },
          }
        : {}),
    };
    writeFileSync(
      path.join(stateDir, "warm-reload-fixture.json"),
      `${JSON.stringify(fixtureSummary, null, 2)}\n`,
    );
    return {
      env,
      configPath,
      workspaceDir,
      token,
      chatPath: buildControlUiSessionPath({
        namespace: "chat",
        sessionKey: targets[0]!.key,
        ...(options.transcriptLatePaint
          ? { displayName: targets[0]!.label, shortIdLength: 32 }
          : { exactKey: true }),
      })!,
      dashboardPath: buildControlUiSessionPath({
        namespace: "dashboard",
        sessionKey: targets[1]!.key,
        ...(options.transcriptLatePaint
          ? { displayName: targets[1]!.label, shortIdLength: 32 }
          : { exactKey: true }),
      })!,
      fixtureSummary,
      async prepareGateway(request: RequestGateway) {
        await request("sessions.groups.put", {
          names: sidebarGroups,
          sectionOrder: sidebarSectionOrder,
        });
        await request("board.widget.put", {
          sessionKey: targets[1]!.key,
          name: "warm-reload-verification",
          title: "Synthetic reload dashboard",
          placement: { size: "full" },
          content: {
            kind: "html",
            html: "<!doctype html><html><head><style>body{font:18px system-ui;background:#10262c;color:#edf8f6;padding:36px}section{display:flex;gap:24px}article{background:#1d4248;border-radius:12px;padding:28px;flex:1}strong{font-size:48px;display:block}</style></head><body><h1>Synthetic reload dashboard</h1><p>Isolated Gateway • synthetic Team-shaped state</p><section><article><strong>3,000</strong>retained sessions</article><article><strong>9</strong>complete assistant rows</article><article><strong>11</strong>warm reload samples</article></section><h2>Verification queue</h2><p>Cache the full page, reconnect live authority, and update facts in place.</p><script>document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => window.top.postMessage({type: 'warm-reload-proof:dashboard-content-ready'}, '*'))));</script></body></html>",
          },
        });
      },
      async close() {
        await stopMock?.();
        stopMock = undefined;
      },
    };
  } catch (error) {
    await stopMock?.();
    throw error;
  } finally {
    process.env = previousEnv;
  }
}
