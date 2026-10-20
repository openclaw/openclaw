import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { expect, it, onTestFinished } from "vitest";
import { buildGrokMigrationProvider } from "./provider.js";

async function fixture() {
  const temp = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "grok-migration-provider-",
  });
  onTestFinished(async () => {
    await temp.cleanup();
  });
  const source = path.join(temp.dir, "source");
  const workspace = path.join(temp.dir, "workspace");
  await fs.mkdir(source);
  const snapshot = {
    format: "grok-migration",
    version: 1,
    mainAgentId: "researcher",
    settings: { userTimeZoneOverride: "America/Los_Angeles" },
    agents: [
      {
        id: "researcher",
        profile: {
          name: "Researcher",
          description: "Always cite primary sources.\nKeep every source detail.",
          avatarShape: "hex",
          avatarColor: "blue",
        },
        memory: [{ kind: "profile", content: "The user prefers concise evidence." }],
        skills: [
          {
            name: "Research",
            description: "Find primary evidence",
            content: "Read all source pages before drawing a conclusion.",
          },
        ],
        routines: [],
        plugins: [],
      },
    ],
    mcpConfig: { mcpServers: {} },
  };
  const snapshotPath = path.join(source, "grok-migration.json");
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  const ctx: MigrationProviderContext = {
    source,
    stateDir: path.join(temp.dir, "state"),
    reportDir: path.join(temp.dir, "report"),
    config: { agents: { defaults: { workspace } } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return { source, workspace, ctx, snapshot, snapshotPath };
}

it("previews account data and preserves full bot content, identity, memory and skills on apply", async () => {
  const { ctx, workspace } = await fixture();
  const provider = buildGrokMigrationProvider();
  expect(await provider.detect!(ctx)).toMatchObject({ found: true });
  const plan = await provider.plan(ctx);
  expect(plan.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "config:grok:timezone",
        target: "agents.defaults.userTimezone",
      }),
      expect.objectContaining({
        kind: "memory",
        action: "append",
        target: path.join(workspace, "MEMORY.md"),
      }),
      expect.objectContaining({
        kind: "skill",
        details: expect.objectContaining({ skillName: "Research" }),
        target: path.join(workspace, "skills/research/SKILL.md"),
      }),
    ]),
  );
  await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  // Select workspace items exactly as CLI item selection does; config/native owners have separate integration proof.
  const files = { ...plan, items: plan.items.filter((item) => item.details?.relativePath) };
  const result = await provider.apply(ctx, files);
  expect(result.summary.errors).toBe(0);
  expect(result.summary.migrated).toBe(files.items.length);
  expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
    "Always cite primary sources.\nKeep every source detail.",
  );
  expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
    "- Avatar: assets/grok-avatar.svg",
  );
  expect(await fs.readFile(path.join(workspace, "assets/grok-avatar.svg"), "utf8")).toContain(
    "<svg",
  );
  expect(await fs.readFile(path.join(workspace, "skills/research/SKILL.md"), "utf8")).toContain(
    "Read all source pages before drawing a conclusion.",
  );
  const memory = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf8");
  expect(memory).toContain("The user prefers concise evidence.");
  expect((await provider.apply(ctx, files)).summary.errors).toBe(0);
  expect(await fs.readFile(path.join(workspace, "MEMORY.md"), "utf8")).toBe(memory);
});

it("reports existing instructions and unavailable memory without overwriting or inventing data", async () => {
  const { ctx, workspace, snapshot, snapshotPath } = await fixture();
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "SOUL.md"), "Existing user instructions");
  const { memory: _memory, ...agent } = snapshot.agents[0]!;
  await fs.writeFile(snapshotPath, JSON.stringify({ ...snapshot, agents: [agent] }));
  const plan = await buildGrokMigrationProvider().plan(ctx);
  expect(plan.items).toContainEqual(
    expect.objectContaining({ target: path.join(workspace, "SOUL.md"), status: "conflict" }),
  );
  expect(plan.items).toContainEqual(
    expect.objectContaining({ id: "manual:researcher:memory", status: "skipped" }),
  );
  expect(plan.items.some((item) => item.kind === "memory")).toBe(false);
  expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
    "Existing user instructions",
  );
});

it("refuses source content changed after preview", async () => {
  const { ctx, workspace, snapshot, snapshotPath } = await fixture();
  const provider = buildGrokMigrationProvider();
  const plan = await provider.plan(ctx);
  snapshot.agents[0]!.profile.description = "Changed source instructions";
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  const result = await provider.apply(ctx, {
    ...plan,
    items: plan.items.filter((item) => item.target === path.join(workspace, "SOUL.md")),
  });
  expect(result.items[0]).toMatchObject({
    status: "error",
    reason: expect.stringContaining("changed"),
  });
  await expect(fs.stat(path.join(workspace, "SOUL.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("skips incomplete memory and rejects an older plan that selected it", async () => {
  const { ctx, workspace, snapshot, snapshotPath } = await fixture();
  const provider = buildGrokMigrationProvider();
  const original = await provider.plan(ctx);
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      ...snapshot,
      agents: [
        {
          ...snapshot.agents[0]!,
          sourceStatus: { memory: { status: "partial", reason: "Private memory is incomplete." } },
        },
      ],
    }),
  );
  const plan = await provider.plan(ctx);
  expect(plan.items.some((item) => item.kind === "memory")).toBe(false);
  const result = await provider.apply(ctx, {
    ...original,
    items: original.items.filter((item) => item.kind === "memory"),
  });
  expect(result.items[0]?.status).toBe("error");
  await expect(fs.stat(path.join(workspace, "MEMORY.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports credentials as manual even with consent and refuses saved credential actions", async () => {
  const { ctx, snapshot, snapshotPath } = await fixture();
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({ ...snapshot, credentialNames: ["XAI_API_KEY"] }),
  );
  // Deliberately no secrets.json: neither preview nor recovery may resolve this value.
  const provider = buildGrokMigrationProvider();
  const selected = { ...ctx, includeSecrets: true };
  const plan = await provider.plan(selected);
  expect(plan.items.some((item) => item.action === "import-api-key")).toBe(false);
  expect(
    plan.items.some((item) => item.kind === "manual" && item.message?.includes("XAI_API_KEY")),
  ).toBe(true);
  const result = await provider.apply(selected, {
    ...plan,
    items: [
      {
        id: "legacy-credential",
        kind: "secret",
        action: "import-api-key",
        status: "planned",
        details: { selectorId: "old-selector", provider: "xai", profileId: "xai:old" },
      },
    ],
  });
  expect(result.items[0]).toMatchObject({
    status: "skipped",
    reason: expect.stringContaining("not copied"),
  });
  await expect(fs.stat(path.join(ctx.stateDir, "credentials"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("offers curated integration setup without guessing packages from display names", async () => {
  const { ctx, snapshot, snapshotPath, workspace } = await fixture();
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      ...snapshot,
      agents: [
        {
          ...snapshot.agents[0]!,
          plugins: [
            { pluginId: "48668144", name: "AgentMail", description: "Preferred research inbox." },
            { pluginId: "unknown", name: "AgentMail", description: "Unverified service." },
          ],
        },
      ],
    }),
  );
  const provider = buildGrokMigrationProvider();
  const plan = await provider.plan(ctx);
  const integrations = plan.items.filter((item) => item.source?.includes(".plugins."));
  expect(integrations).toHaveLength(2);
  expect(integrations[0]).toMatchObject({
    status: "skipped",
    reason: expect.stringContaining("clawhub:@agentmail/agentmail --no-enable"),
  });
  expect(integrations[1]).toMatchObject({
    status: "skipped",
    reason: expect.stringContaining("No package is installed by name matching"),
  });
  await provider.apply(ctx, {
    ...plan,
    items: plan.items.filter((item) => item.details?.relativePath === "GROK-IMPORT.md"),
  });
  const guide = await fs.readFile(path.join(workspace, "GROK-IMPORT.md"), "utf8");
  expect(guide).toContain("Grok connect cards, secret-request");
  expect(guide).toContain("Preferred research inbox.");
  expect(guide).toContain("No verified native mapping; manual setup required.");
});
