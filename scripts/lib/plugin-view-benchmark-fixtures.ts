import type { ControlUiMockGateway } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiMockSessionRow } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";

export const remainingPluginIds = [
  "x",
  "clawrouter",
  "whatsapp",
  "knowledge",
  "mcp-relay",
] as const;

export const remainingPluginPages = {
  x: { id: "replies", label: "X replies" },
  clawrouter: { id: "pool", label: "ClawRouter" },
  knowledge: { id: "overview", label: "Knowledge" },
  "mcp-relay": { id: "connected-apps", label: "Connected apps" },
} as const;

export function createXFixture(count: number, now: number) {
  const accounts = [
    { accountId: "primary", username: "fixture_bot" },
    { accountId: "secondary", username: "fixture_help" },
  ];
  const snapshots = accounts.map((account, accountIndex) => ({
    accountId: account.accountId,
    username: account.username,
    accounts,
    entries: Array.from({ length: count }, (_, index) => ({
      userId: String(1_000_000 + accountIndex * 100_000 + index),
      username: `${accountIndex ? "s" : "p"}_user_${String(index).padStart(4, "0")}`,
      name: `Fixture member ${String(index).padStart(4, "0")}`,
      configured: index % 5 === 0,
      editable: index % 5 !== 0,
      addedBy: "fixture-operator",
      addedAt: now - 86_400_000,
    })),
    guests: {
      enabled: false,
      helpersAvailable: true,
      maxMentionsPerAuthorPerDay: 5,
      admittedToday: 2,
      rateLimitedToday: 1,
    },
    spend: {
      dayUsd: 0.25,
      cycleUsd: 2.5,
      dailyLimitUsd: 5,
      monthlyLimitUsd: 50,
      cycleStart: "2026-10-01",
    },
    verifiedFromGitHub: {
      repo: "example/fixture-repo",
      stale: false,
      lastSyncAt: now - 3_600_000,
      unresolvedHandles: ["missing_fixture"],
      entries: Array.from({ length: Math.ceil(count / 2) }, (_, index) => ({
        xUserId: String(2_000_000 + accountIndex * 100_000 + index),
        xHandle: `${accountIndex ? "s" : "p"}_gh_${String(index).padStart(4, "0")}`,
        githubLogin: `fixture-contributor-${String(index).padStart(4, "0")}`,
        permission: ["push", "maintain", "admin"][index % 3],
        syncedAt: now - 3_600_000,
      })),
    },
  }));
  return { plugin: "x" as const, count, snapshots, now };
}

export function createClawRouterFixture(now: number) {
  const observedAt = new Date(now - 60_000).toISOString();
  const models = Array.from(
    { length: 20 },
    (_, index) => `fixture/model-${String(index).padStart(2, "0")}`,
  );
  const traffic = (index: number) => ({
    provider: "fixture-provider",
    requests: 10 + index,
    inputTokens: 1_000 + index,
    outputTokens: 100 + index,
    cacheReadTokens: 500 + index,
    cacheWriteTokens: 50 + index,
    costMicros: 20_000 + index,
  });
  const pool = {
    version: "clawrouter.pool.v1",
    observedAt,
    policyId: "fixture-pool",
    routing: {
      strategy: "included-first",
      includedQuotaReservePercent: 10,
      environmentFallback: true,
    },
    models,
    grants: Array.from({ length: 20 }, (_, index) => ({
      key: `subscription/grant-${String(index).padStart(2, "0")}`,
      label: `Fixture subscription ${String(index).padStart(2, "0")}`,
      provider: "fixture-provider",
      kind: index % 2 ? "oauth" : "subscription",
      enabled: true,
      credentialStatus: "ready",
      plan: "Fixture",
      account: {
        email: `subscription${index}@example.test`,
        rateLimitTier: "fixture",
        subscriptionStatus: "active",
      },
      windows: Array.from({ length: 4 }, (_window, window) => ({
        id: ["five-hour", "weekly", "family-a", "family-b"][window],
        window: window ? "weekly" : "5h",
        models: window < 2 ? null : [`fixture-family-${window === 2 ? "a" : "b"}`],
        remainingPercent: 20 + ((index * 7 + window * 13) % 75),
        resetAt: new Date(now + 86_400_000).toISOString(),
        observedAt,
      })),
      extraUsage: {
        enabled: true,
        usedCredits: 1250 + index,
        monthlyLimit: 10_000,
        currency: "USD",
        spendLimitReached: false,
      },
      eligibility: Object.fromEntries(
        models.flatMap((model, modelIndex) =>
          index % 3 === 0 && modelIndex === 19
            ? []
            : [
                [
                  model,
                  ["eligible", "exhausted", "cooldown", "stale", "reauth_required"][
                    (index + modelIndex) % 5
                  ],
                ],
              ],
        ),
      ),
      lastSelectedAt: observedAt,
      selectedCount: 42 + index,
    })),
    usage: {
      days: 30,
      lanes: Array.from({ length: 20 }, (_, index) => ({
        ...traffic(index),
        grantLane: ["subscription", "oauth", "api_key", "environment"][index % 4],
      })),
      grants: Array.from({ length: 380 }, (_, index) => ({
        ...traffic(index),
        grantKey: `grant-${String(index % 20).padStart(2, "0")}`,
      })),
    },
  };
  return { plugin: "clawrouter" as const, pool, now };
}

export function createMcpRelayFixture(count: number, now: number) {
  const caller = {
    principal: { kind: "owner" },
    principalLabel: "Benchmark operator",
    ceiling: ["operator.read", "operator.write", "operator.admin"],
    canAdmin: true,
    canPair: true,
  };
  return {
    plugin: "mcp-relay" as const,
    count,
    now,
    snapshot: {
      caller,
      relayUrl: "https://relay.example.test",
      grants: Array.from({ length: count }, (_, index) => ({
        grantId: `fixture-grant-${index}`,
        clientId: `fixture-client-${index}`,
        clientName: `Fixture app ${String(index).padStart(3, "0")}`,
        principal: caller.principal,
        principalLabel: caller.principalLabel,
        ceiling: ["operator.read", "operator.write"],
        createdAt: now - 86_400_000 - index * 1000,
        lastUsedAt: now - 60_000 - index * 1000,
      })),
    },
    consent: {
      kind: "oauth",
      clientName: "Fixture consent client",
      redirectHost: "client.example.test",
      expiresAt: now + 3_600_000,
      caller,
    },
    pairing: {
      code: "SYNTHETIC-ONLY",
      expiresAt: now + 3_600_000,
      mcpUrl: "https://relay.example.test/mcp",
    },
  };
}

export function createWhatsAppFixture(now: number, localeProof = false) {
  const config = { ui: { prefs: { locale: "en" } } };
  const hash = "whatsapp-locale-0";
  return {
    plugin: "whatsapp" as const,
    now,
    localeProof,
    configResponse: {
      config,
      hash,
      configRevisionHash: hash,
      appliedConfigHash: hash,
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    status: {
      ts: now,
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
      channels: {
        whatsapp: {
          configured: true,
          linked: false,
          running: false,
          connected: false,
          reconnectAttempts: 0,
          authAgeMs: 60_000,
          lastConnectedAt: now - 60_000,
          lastMessageAt: now - 60_000,
        },
      },
      channelAccounts: {
        whatsapp: [
          {
            accountId: "default",
            configured: true,
            linked: false,
            running: false,
            connected: false,
          },
        ],
      },
      channelDefaultAccountId: { whatsapp: "default" },
    },
    // A local synthetic PNG. No relay, phone, or account is contacted.
    qrDataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  };
}

export function createKnowledgeFixture(count: number, now: number) {
  const at = new Date(now - 3_600_000).toISOString();
  const hash = "a".repeat(64);
  const summary = (index: number, kind = "page") => ({
    id: `${kind}-${index}`,
    title: `Fixture ${kind} ${String(index).padStart(3, "0")}`,
    kind,
    type: kind === "claim" ? "fact" : "project",
    path: `${kind}s/fixture-${index}.md`,
    lifecycle: "active",
    revision: 1,
    valid: true,
    recordedAt: at,
    updatedAt: at,
  });
  const pages = Array.from({ length: count }, (_, index) => summary(index));
  const claims = Array.from({ length: 60 }, (_, index) => ({
    ...summary(index, "claim"),
    card: {
      hash,
      body: `Synthetic saved fact ${index}.`,
      truncated: false,
      evidenceTotal: 0,
      metadata: {},
    },
  }));
  const source = { ...summary(999), title: "Fixture grouped source" };
  const freshness = { queriedAt: at, scannedAt: at, indexedAt: at };
  const status = {
    service: "knowledge",
    phase: "structured-writes",
    limits: {
      recordBytes: 5_000_000,
      bodyInputChars: 48_000,
      textPageChars: 65_536,
      recordResponseBytes: 245_760,
    },
    backendRevision: "fixture",
    instanceId: "fixture-instance",
    startedAt: at,
    checkedAt: at,
    snapshot: hash,
    vault: "fixture-vault",
    agent: "main",
    store: "ready",
    scope: "fixture-main",
    writesEnabled: true,
    live: "watching",
    records: count + claims.length,
    validRecords: count + claims.length,
    definitions: 1,
    ontologyAvailable: true,
    ontologyFingerprint: hash,
    issues: 0,
  };
  const sessionKey = "agent:main:main";
  const session = createControlUiMockSessionRow(sessionKey, "Benchmark Knowledge", now, {
    sessionId: "00000000-0000-4000-8000-000000000001",
    agentId: "main",
  });
  const recentItems = pages.slice(0, 20).map((record, index) => ({
    sequence: 300 - index,
    id: record.id,
    at,
    kind: record.kind,
    type: record.type,
    change: "created",
    title: record.title,
  }));
  return {
    plugin: "knowledge" as const,
    count,
    now,
    at,
    hash,
    pages,
    claims,
    source,
    freshness,
    status,
    upperSequence: 300,
    recentItems,
    sessionKey,
    session,
  };
}

export type RemainingFixture = ReturnType<
  | typeof createXFixture
  | typeof createClawRouterFixture
  | typeof createMcpRelayFixture
  | typeof createWhatsAppFixture
  | typeof createKnowledgeFixture
>;

/** Runs inside the browser; state belongs to the synthetic transport, never the renderer. */
export function installRemainingPluginMock(fixture: RemainingFixture) {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Missing synthetic Gateway");
  }
  if (fixture.plugin === "x") {
    for (const method of [
      "x.allowlist.list",
      "x.allowlist.add",
      "x.allowlist.remove",
      "x.guests.set",
    ]) {
      gateway.setRequestHandler(method, ({ params, respond }) => {
        const request = params as {
          accountId?: string;
          username?: string;
          userId?: string;
          enabled?: boolean;
        };
        const snapshot = fixture.snapshots.find(
          (value) => value.accountId === (request.accountId ?? "primary"),
        );
        if (!snapshot) {
          throw new Error("Unknown benchmark X account");
        }
        if (method === "x.allowlist.add") {
          snapshot.entries.push({
            userId: "99999999",
            username: request.username!.replace(/^@/, ""),
            name: "Fixture added member",
            configured: false,
            editable: true,
            addedBy: "fixture-operator",
            addedAt: fixture.now,
          });
        } else if (method === "x.allowlist.remove") {
          snapshot.entries = snapshot.entries.filter((entry) => entry.userId !== request.userId);
        } else if (method === "x.guests.set") {
          snapshot.guests.enabled = request.enabled!;
        }
        respond(snapshot);
      });
    }
  } else if (fixture.plugin === "mcp-relay") {
    gateway.setRequestHandler("mcp-relay.grants", ({ respond }) => respond(fixture.snapshot));
    gateway.setRequestHandler("mcp-relay.revoke", ({ params, respond }) => {
      fixture.snapshot.grants = fixture.snapshot.grants.filter(
        (grant) => grant.grantId !== (params as { grantId: string }).grantId,
      );
      respond({ ok: true });
    });
    gateway.setRequestHandler("mcp-relay.pair", ({ respond }) => respond(fixture.pairing));
    gateway.setRequestHandler("mcp-relay.authorize.describe", ({ respond }) =>
      respond(fixture.consent),
    );
  } else if (fixture.plugin === "clawrouter") {
    gateway.setRequestHandler("clawrouter.pool.get", ({ respond }) =>
      respond({ status: "ok", pool: fixture.pool }),
    );
  } else if (fixture.plugin === "knowledge") {
    gateway.setRequestHandler("plugins.sessionAction", ({ params, respond }) => {
      const request = params as {
        pluginId: string;
        actionId: string;
        payload: Record<string, unknown>;
      };
      if (request.pluginId !== "knowledge") {
        throw new Error("Unexpected fixture feature plugin");
      }
      const proxy = request.actionId === "agent_query";
      const operation = proxy ? String(request.payload.operation) : request.actionId;
      const input = (proxy ? request.payload.input : request.payload) as {
        id?: string;
        offset?: number;
        kind?: string;
        sourceId?: string;
        recordOffset?: number;
        filter?: string;
        before?: number;
        upper?: number;
        sessionKey?: string;
        sessionId?: string;
        maxChars?: number;
      };
      const offset = input.offset ?? 0;
      const reply = (result: unknown) => respond({ ok: true, result });
      if (operation === "stores_snapshot") {
        reply({
          revision: fixture.hash,
          defaultAgent: "main",
          agents: [{ id: "main", name: "Benchmark", supported: true, binding: "isolated:main" }],
          stores: [
            {
              binding: "isolated:main",
              kind: "isolated",
              owner: "main",
              label: "Benchmark",
              members: ["main"],
              retained: false,
              state: "ready",
              records: fixture.count,
            },
          ],
          canChange: false,
          issues: [],
        });
      } else if (operation === "status") {
        reply(fixture.status);
      } else if (operation === "ontology") {
        reply({
          view: "catalog",
          available: true,
          name: "fixture",
          version: "1",
          fingerprint: fixture.hash,
          total: 1,
          offset: 0,
          nextOffset: null,
          totalIssues: 0,
          definitions: [
            {
              name: "project",
              label: "Project",
              kind: "page",
              primitive: "concept",
              description: "Synthetic projects",
              aliases: [],
              recordCount: fixture.count,
            },
          ],
        });
      } else if (operation === "recent") {
        if (input.sourceId !== undefined && input.sourceId !== fixture.source.id) {
          throw new Error("Unexpected Knowledge benchmark source");
        }
        const recordOffset = input.recordOffset ?? 0;
        const group = {
          source: fixture.source,
          total: 60,
          counts: { fact: 60 },
          records: fixture.claims.slice(recordOffset, recordOffset + 20),
          truncated: recordOffset + 20 < 60,
          nextRecordOffset: recordOffset + 20 < 60 ? recordOffset + 20 : null,
          firstSaved: fixture.at,
          lastSaved: fixture.at,
        };
        const sourceRecordId = fixture.pages[0]!.id;
        const entries = fixture.recentItems
          .filter((entry) => !input.sourceId || entry.id === sourceRecordId)
          .slice(0, 20)
          .map((entry) => Object.assign({}, entry, entry.id === sourceRecordId ? { group } : {}));
        reply({ upperSequence: fixture.upperSequence, nextBefore: null, items: entries });
      } else if (operation === "records") {
        const records = input.kind === "claim" ? fixture.claims : fixture.pages;
        const limit = input.kind === "claim" ? 20 : 50;
        reply({
          records: records.slice(offset, offset + limit),
          total: records.length,
          offset,
          nextOffset: offset + limit < records.length ? offset + limit : null,
          freshness: fixture.freshness,
          ...(input.kind === "claim"
            ? { facets: { kinds: { fact: 60 }, origins: { source: 60 } } }
            : {}),
        });
      } else if (operation === "lookup" || operation === "grep") {
        const records = fixture.pages.slice(0, operation === "lookup" ? 1 : 20);
        const hits = records.map((record) => ({
          record,
          citation: { id: record.id, path: record.path, revision: 1, hash: fixture.hash },
          snippet: {
            field: "body",
            text: "Synthetic benchmark search match.",
            start: 0,
            end: 33,
            startLine: 1,
            endLine: 1,
            truncated: false,
          },
          matches: ["body"],
          score: 1,
          attribution: "Fixture",
          assertionOrigin: "source",
          evidence: [],
          evidenceTruncated: false,
        }));
        reply({
          hits,
          resultCount: hits.length,
          offset: 0,
          nextOffset: null,
          total: hits.length,
          freshness: fixture.freshness,
          coverage: { complete: true, message: "" },
          ...(operation === "lookup"
            ? { outcome: "found" }
            : {
                mode: "keyword",
                queryMode: "all",
                index: { state: "ready", lag: false, snapshot: fixture.hash, message: "" },
              }),
        });
      } else if (operation === "record") {
        const record = fixture.pages.find((entry) => entry.id === input.id) ?? fixture.pages[0]!;
        const preview = input.maxChars === 5000;
        const initial =
          "# Fixture notes\n\nInitial notes marker.\n\n**Synthetic** saved knowledge.";
        const continuation = "\n\nContinuation marker.";
        const body = preview
          ? `Preview start. ${"Synthetic note. ".repeat(400)}`.slice(0, 4987) + " Preview end."
          : offset
            ? continuation
            : initial;
        reply({
          view: "content",
          record: { ...record, hash: fixture.hash, body, metadata: {} },
          content: {
            offset,
            totalChars: preview ? 7000 : initial.length + continuation.length,
            nextOffset: preview ? 5000 : offset ? null : initial.length,
          },
          issues: [],
          links: [],
          references: [],
          referenceTotal: 0,
          evidence: [],
          evidenceTotal: 0,
          sourceFiles: [],
          sourceFilesTotal: 0,
          nextReferenceOffset: null,
          nextEvidenceOffset: null,
        });
      } else if (operation === "connections") {
        reply({ connections: [], total: 0, nextOffset: null, snapshot: fixture.hash });
      } else if (operation === "timeline") {
        reply({
          items: [],
          total: 0,
          offset,
          nextOffset: null,
          snapshot: fixture.hash,
          freshness: fixture.freshness,
          coverage: { complete: true, message: "Fixture records have no dated sources." },
        });
      } else if (operation === "history") {
        reply({
          git: { state: "idle", pending: 0, message: "" },
          entries: [],
          mutations: [],
          nextOffset: null,
        });
      } else if (operation === "session_activity") {
        if (
          input.sessionKey !== fixture.sessionKey ||
          input.sessionId !== fixture.session.sessionId
        ) {
          throw new Error("Unexpected Knowledge benchmark session");
        }
        if (
          (input.upper !== undefined && input.upper !== 80) ||
          (input.before !== undefined && input.upper !== 80)
        ) {
          throw new Error("Unexpected Knowledge benchmark activity window");
        }
        const upper = input.upper ?? 80;
        const all = Array.from({ length: 80 }, (_, index) => ({
          sequence: 80 - index,
          at: fixture.at,
          operation: index % 2 ? "save" : "record",
          action: index % 2 ? "write" : "read",
          id: fixture.pages[index % fixture.pages.length]!.id,
          title: `Fixture activity ${String(index).padStart(2, "0")}`,
          kind: "page",
          type: "project",
          revision: 1,
          toolCallId: `fixture-call-${index}`,
        })).filter(
          (row) =>
            row.sequence <= upper &&
            (!input.filter || row.action === input.filter) &&
            (!input.before || row.sequence < input.before),
        );
        reply({
          upper,
          nextBefore: all.length > 40 ? all[39]!.sequence : null,
          items: all.slice(0, 40),
        });
      } else {
        throw new Error(`Unexpected Knowledge benchmark operation: ${operation}`);
      }
    });
  } else {
    gateway.setRequestHandler("channels.status", ({ respond }) => respond(fixture.status));
    gateway.setRequestHandler("web.login.start", ({ respond }) =>
      respond({
        connected: false,
        message: "Scan this synthetic QR.",
        qrDataUrl: fixture.qrDataUrl,
      }),
    );
    gateway.setRequestHandler("web.login.wait", ({ respond }) => {
      Object.assign(fixture.status.channels.whatsapp, {
        linked: true,
        running: true,
        connected: true,
      });
      Object.assign(fixture.status.channelAccounts.whatsapp[0]!, {
        linked: true,
        running: true,
        connected: true,
      });
      respond({ connected: true, message: "Linked." });
    });
  }
}
