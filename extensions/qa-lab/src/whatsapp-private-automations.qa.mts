import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";
import { writeQaAuthProfiles } from "./providers/shared/auth-store.ts";
import { startReportMcp } from "./whatsapp-automation-mcp.test-support.ts";

async function run() {
  const outputDir = await mkdtemp(path.join(homedir(), "whatsapp-qa-"));
  console.log("QA output", outputDir);
  const accounts = { original: "qa-synthetic-original", alternate: "qa-synthetic-alternate" };
  const provider = await startAutomationProvider("whatsapp_automations", accounts);
  const owner = createQaGatewayChild();
  let transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>> | undefined;
  const mode = process.argv[2];
  assert.ok(!mode || ["static", "connected", "mixed"].includes(mode));
  const sources = mode === "mixed" ? ["static", "connected"] : mode ? [mode] : [];
  let reports: Awaited<ReturnType<typeof startReportMcp>> | undefined;
  await runQaGatewayFixture(
    async () => {
      transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          channel: "whatsapp",
          channelDriver: "crabline",
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const adapter = transport;
      const ordersFile = path.join(outputDir, "orders.json");
      const alice = "15550000001@s.whatsapp.net";
      const bob = "15550000003@s.whatsapp.net";
      const setOrders = (quantities: number[]) =>
        writeFile(
          ordersFile,
          JSON.stringify({
            [adapter.accountId]: { "+15550000001": quantities, "+15550000003": [999] },
          }),
        );
      await setOrders([1]);
      const runtimeEnvPatch: Record<string, string> = {
        ...adapter.createRuntimeEnvPatch(),
        OPENCLAW_QA_PERSONAL_ORDERS_FILE: ordersFile,
      };
      if (mode) {
        reports = await startReportMcp(adapter.accountId);
        runtimeEnvPatch.OPENCLAW_QA_WHATSAPP_REPORT_PORT = new URL(reports.origin).port;
      }
      const socketUrl = runtimeEnvPatch.OPENCLAW_WHATSAPP_WEB_SOCKET_URL;
      assert.ok(socketUrl);
      assert.equal(new URL(socketUrl).hostname, "127.0.0.1");
      const gateway = await owner.start({
        runtimeEnvPatch,
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.resolve("openclaw.mjs")],
          cwd: process.cwd(),
          usePackagedPlugins: false,
        },
        providerMode: "mock-openai",
        providerBaseUrl: provider.baseUrl,
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        forcedRuntime: "openclaw",
        transport: adapter,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig(cfg) {
          cfg.commands = { ...cfg.commands, ownerAllowFrom: ["whatsapp:+15550000002"] };
          cfg.messages = { ...cfg.messages, queue: { mode: "followup" } };
          cfg.session = { ...cfg.session, dmScope: "per-account-channel-peer" };
          const wa = cfg.channels!.whatsapp!;
          wa.accounts![adapter.accountId] = {
            ...wa.accounts![adapter.accountId],
            dmPolicy: "allowlist",
            allowFrom: ["+15550000001", "+15550000002", "+15550000003"],
          };
          cfg.plugins = { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } };
          cfg.plugins.allow = [...new Set([...(cfg.plugins.allow ?? []), "qa-lab"])];
          cfg.plugins.entries = { ...cfg.plugins.entries, "qa-lab": { enabled: true } };
          const allow = reports
            ? [
                "whatsapp_automations",
                ...sources.flatMap((name) => [`${name}__report`, `${name}__amend`]),
              ]
            : ["whatsapp_automations", "session_status", "qa_my_orders"];
          if (reports) {
            const origin = reports.origin;
            cfg.mcp = {
              servers: Object.fromEntries(
                sources.map((name) => [
                  name,
                  {
                    url: `${origin}/${name}`,
                    transport: "streamable-http",
                    ...(name === "static"
                      ? { headers: { Authorization: "Bearer fixture-shared" } }
                      : {}),
                    codex: { defaultToolsApprovalMode: "auto" },
                  },
                ]),
              ),
            };
          }
          const tools = {
            profile: "full" as const,
            allow,
          };
          cfg.tools = {
            ...tools,
            codeMode: false,
            toolSearch: false,
            gatewayPolicy: {
              allow,
              actions: {
                whatsapp_automations: ["add", "list", "update", "remove"],
                qa_my_orders: ["list", "mark_reviewed"],
              },
              automations: { scope: "caller" },
            },
          };
          const agents = ((cfg.agents ??= {}).entries ??= {});
          (agents.qa ??= {}).tools = tools;
          return cfg;
        },
      });
      await gateway.restartAfterStateMutation(async ({ configPath, stateDir }) => {
        const cfg = JSON.parse(await readFile(configPath, "utf8"));
        delete cfg.models.providers["mock-openai"].apiKey;
        cfg.auth ??= {};
        cfg.auth.order = { ...cfg.auth.order, "mock-openai": Object.keys(accounts) };
        await writeQaAuthProfiles({
          stateDir,
          agentId: "qa",
          profiles: Object.fromEntries(
            Object.entries(accounts).map(([id, key]) => [
              id,
              { provider: "mock-openai", type: "api_key", key },
            ]),
          ),
        });
        await writeFile(configPath, JSON.stringify(cfg));
      });
      await adapter.waitReady({ gateway });
      const job = {
        name: "Synthetic scheduled reminder",
        enabled: false,
        schedule: { kind: "every", everyMs: 3600000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Read a book." },
        delivery: { mode: "none" },
      };
      const saved = (await gateway.call("cron.add", {
        ...job,
        agentId: "qa",
        name: "Operator test job",
      })) as { id: string };
      assert.ok(saved.id);
      const readJobs = async () =>
        (
          (await gateway.call("cron.list", { includeDisabled: true })) as {
            jobs: { id: string; name: string }[];
          }
        ).jobs.map((j) => ({ id: j.id, name: j.name }));
      const before = await readJobs();
      assert.ok(before.some((j) => j.id === saved.id && j.name === "Operator test job"));

      const replyPeers = new Map<string, string>();
      async function ask(senderId: string, marker: string, args: Record<string, unknown>) {
        const sinceIndex = adapter.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound").length;
        provider.requests.set(marker, args);
        const conversation = { id: senderId, kind: "direct" as const };
        await adapter.sendInbound({
          accountId: adapter.accountId,
          conversation,
          senderId,
          text: `Manage my reminder [automation-proof:${marker}]`,
        });
        const reply = await adapter.waitForOutbound({
          sinceIndex,
          textIncludes: `${marker}:`,
          timeoutMs: 45_000,
        });
        assert.equal(reply.accountId, adapter.accountId);
        replyPeers.set(senderId, reply.conversation.id);
        const result = provider.results.get(marker);
        assert.ok(result, JSON.stringify(provider.diagnostics(marker)));
        console.log(marker, result.slice(0, 300));
        return result;
      }
      async function completed(id: string, status: string) {
        await adapter.waitForCondition(async () => {
          const page = (await gateway.call("cron.runs", { id })) as {
            entries: { status: string }[];
          };
          return page.entries.some((entry) => entry.status === status) || null;
        }, 45_000);
      }
      if (reports) {
        const at = new Date(Date.now() + 100_000);
        // Avoid cron's top-of-hour staggering.
        if (at.getUTCMinutes() === 0) {
          at.setUTCMinutes(1);
        }
        const schedule = {
          kind: "cron",
          expr: `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`,
          tz: "UTC",
        };
        const jobs = new Map<string, string>();
        for (const source of sources) {
          const tool = `${source}__report`;
          provider.requestedTools.set(`initial-${source}`, tool);
          assert.match(await ask(alice, `initial-${source}`, {}), /1 unit\./);
          provider.requestedTools.set(`due-${source}`, tool);
          provider.requests.set(`due-${source}`, {});
          const savedReport = JSON.parse(
            await ask(alice, `save-${source}`, {
              action: "add",
              mode: "task",
              text: `Send today's ${source} report here. [automation-proof:due-${source}]`,
              schedule,
            }),
          );
          assert.ok((await readJobs()).some((j) => j.id === savedReport.id));
          jobs.set(source, savedReport.id);
          assert.ok(
            provider.surfaces.get(`save-${source}`)?.includes(`${source}__amend`),
            "interactive control tool must be present",
          );
          assert.match(
            await ask(bob, `foreign-${source}`, { action: "remove", id: savedReport.id }),
            /not found/i,
          );
        }
        reports.setUnits(17);
        const sinceIndex = adapter.state
          .getSnapshot()
          .messages.filter((m) => m.direction === "outbound").length;
        for (const [source, id] of jobs) {
          const marker = `due-${source}`;
          const occurrence = await adapter.waitForCondition(async () => {
            const page = (await gateway.call("cron.runs", { id })) as {
              entries: { status: string; error?: string }[];
            };
            return page.entries[0] ?? null;
          }, 160_000);
          assert.equal(
            occurrence.status,
            "ok",
            occurrence.error ?? "The daily report did not finish.",
          );
          assert.deepEqual(
            provider.surfaces
              .get(marker)
              ?.filter((tool) => tool.includes("__"))
              .toSorted(),
            sources.map((name) => `${name}__report`).toSorted(),
            "due model must see every eligible report and no consent-required action",
          );
          const message = await adapter.waitForOutbound({
            sinceIndex,
            textIncludes: `Today's ${source} report: 17 units.`,
            timeoutMs: 45_000,
          });
          assert.equal(message.accountId, adapter.accountId);
          assert.equal(message.conversation.id, replyPeers.get(alice));
          assert.match(provider.results.get(marker) ?? "", /17 units/);
          console.log("daily report", source, id, "17 units in creator DM");
        }
        const calls = reports.calls.slice();
        for (const source of sources) {
          assert.deepEqual(
            calls.filter((call) => call.source === source),
            [1, 17].map((units) => ({ source, tool: "report", units })),
          );
        }
        const config = (await gateway.call("config.get", {})) as { hash: string };
        await gateway.call("config.patch", {
          baseHash: config.hash,
          replacePaths: [`channels.whatsapp.accounts.${adapter.accountId}.allowFrom`],
          raw: JSON.stringify({
            channels: {
              whatsapp: { accounts: { [adapter.accountId]: { allowFrom: ["+15550000003"] } } },
            },
          }),
        });
        const beforeWithdrawal = adapter.state
          .getSnapshot()
          .messages.filter((m) => m.direction === "outbound").length;
        for (const id of jobs.values()) {
          await gateway.call("cron.run", { id, mode: "force" });
          await completed(id, "skipped");
        }
        await adapter.waitForNoOutbound({ sinceIndex: beforeWithdrawal });
        assert.deepEqual(reports.calls, calls);
        return;
      }
      provider.requestedTools.set("interactive-orders", "qa_my_orders");
      assert.deepEqual(JSON.parse(await ask(alice, "interactive-orders", { action: "list" })), {
        quantities: [1],
      });
      // Hold a real foreground model request until the Gateway records the next DM as pending.
      const hold = provider.holdRequest("busy");
      const chatKey = `agent:qa:whatsapp:${adapter.accountId}:direct:+15550000001`;
      await gateway.call("chat.send", {
        sessionKey: chatKey,
        message: "Wait a moment [automation-proof:busy]",
        idempotencyKey: "synthetic-busy-session",
      });
      await adapter.waitForCondition(() => hold.reached || null, 45_000);
      const pending = ask(alice, "create", {
        action: "add",
        text: "Read the blue book",
        schedule: { kind: "every", everyMs: 3_600_000 },
      });
      void pending.catch(() => {});
      try {
        let lastStatus = "";
        await adapter
          .waitForCondition(async () => {
            const status = await fetch(new URL("/tools/invoke", gateway.baseUrl), {
              method: "POST",
              headers: {
                authorization: `Bearer ${gateway.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                tool: "session_status",
                sessionKey: chatKey,
                args: { sessionKey: chatKey },
              }),
            });
            lastStatus = await status.text();
            assert.ok(status.ok, "The operator could not read the live session queue.");
            return /Queue: [^\\]*?depth [1-9]/u.test(lastStatus) || null;
          }, 25_000)
          .catch((cause) => {
            throw new Error(
              `Pending WhatsApp DM: ${lastStatus.slice(-1600)}; ${gateway
                .logs()
                .split("\n")
                .filter((line) => /queue|followup|ingress/iu.test(line))
                .slice(-10)
                .join("\n")}`,
              { cause },
            );
          });
      } finally {
        hold.release();
      }
      const created = JSON.parse(await pending);
      assert.ok(created.id);
      assert.equal(created.text, "Read the blue book");
      assert.ok((await readJobs()).some((j) => j.id === created.id && j.name === created.text));
      assert.ok(
        JSON.parse(await ask(alice, "list", { action: "list" })).jobs.some(
          (j: { id: string }) => j.id === created.id,
        ),
      );
      assert.deepEqual(JSON.parse(await ask(bob, "foreign-list", { action: "list" })).jobs, []);
      assert.match(
        await ask(bob, "foreign-remove", { action: "remove", id: created.id }),
        /not found/i,
      );
      assert.match(
        await ask(alice, "operator-update", { action: "update", id: saved.id, text: "Changed" }),
        /not found/i,
      );
      assert.equal(
        JSON.parse(
          await ask(alice, "update", {
            action: "update",
            id: created.id,
            text: "Read the green book",
          }),
        ).text,
        "Read the green book",
      );
      const outbound = () =>
        adapter.state.getSnapshot().messages.filter((m) => m.direction === "outbound");
      const beforeRun = outbound().length;
      await gateway.call("cron.run", { id: created.id, mode: "force" });
      const delivered = await adapter.waitForOutbound({
        sinceIndex: beforeRun,
        textIncludes: "Read the green book",
        timeoutMs: 45_000,
      });
      assert.equal(delivered.text, "Read the green book");
      assert.notEqual(replyPeers.get(alice), replyPeers.get(bob));
      assert.equal(delivered.conversation.id, replyPeers.get(alice));
      assert.equal(delivered.accountId, adapter.accountId);
      await completed(created.id, "ok");
      await ask(alice, "remove", { action: "remove", id: created.id });
      assert.deepEqual(await readJobs(), before);
      const beforeDue = outbound().length;
      const oneShot = JSON.parse(
        await ask(alice, "one-shot", {
          action: "add",
          text: "One-time scheduled text",
          schedule: { kind: "at", at: new Date(Date.now() + 10_000).toISOString() },
        }),
      );
      assert.ok((await readJobs()).some((j) => j.id === oneShot.id));
      const due = await adapter.waitForCondition(
        () =>
          outbound()
            .slice(beforeDue)
            .find((m) => m.text === "One-time scheduled text"),
        45_000,
      );
      assert.equal(due.conversation.id, replyPeers.get(alice));
      assert.equal(due.accountId, adapter.accountId);
      await completed(oneShot.id, "ok");
      provider.requestedTools.set("due-orders", "qa_my_orders");
      provider.requests.set("due-orders", { action: "list" });
      const dueAt = new Date(Date.now() + 90_000);
      if (dueAt.getUTCMinutes() === 0) {
        dueAt.setUTCMinutes(1);
      }
      const daily = {
        kind: "cron",
        expr: `${dueAt.getUTCMinutes()} ${dueAt.getUTCHours()} * * *`,
        tz: "UTC",
      };
      const task = JSON.parse(
        await ask(alice, "schedule-orders", {
          action: "add",
          mode: "task",
          text: "Check my orders and summarize them here. [automation-proof:due-orders]",
          schedule: daily,
        }),
      );
      assert.equal(task.mode, "task");
      assert.ok((await readJobs()).some((j) => j.id === task.id));
      assert.deepEqual(provider.inferenceAccounts.get("schedule-orders"), new Set(["original"]));
      const stored = (() => {
        using db = new DatabaseSync(
          path.join(gateway.tempRoot, "state", "state", "openclaw.sqlite"),
          { readOnly: true },
        );
        return db
          .prepare(
            "SELECT json_extract(job_json, '$.inferenceBinding.profileId') AS profile, json_extract(job_json, '$.payload.task.sessionId') AS session FROM cron_jobs WHERE job_id = ?",
          )
          .get(task.id);
      })();
      assert.equal(stored?.profile, "original");
      assert.ok(stored.session);
      const selection = (await gateway.call("config.get", {})) as { hash: string };
      await gateway.call("config.patch", {
        baseHash: selection.hash,
        replacePaths: ["auth.order.mock-openai"],
        raw: JSON.stringify({ auth: { order: { "mock-openai": ["alternate", "original"] } } }),
      });
      const reset = (await gateway.call("sessions.reset", {
        key: chatKey,
        expectedSessionId: stored.session,
      })) as {
        ok: boolean;
        key: string;
      };
      assert.ok(reset.ok);
      assert.equal(reset.key, chatKey);
      assert.ok(
        JSON.parse(await ask(alice, "after-reset", { action: "list" })).jobs.some(
          (j: { id: string }) => j.id === task.id,
        ),
      );
      assert.deepEqual(provider.inferenceAccounts.get("after-reset"), new Set(["alternate"]));
      assert.match(
        await ask(bob, "foreign-task", { action: "update", id: task.id, text: "Changed" }),
        /not found/i,
      );
      const patchSearch = async (webSearch: boolean) => {
        const result = (await gateway.call("sessions.patch", {
          key: chatKey,
          toolOverrides: { webSearch },
        })) as { entry: { toolOverrides: { webSearch: boolean } } };
        assert.equal(result.entry.toolOverrides.webSearch, webSearch);
      };
      await patchSearch(false);
      await setOrders([3, 8]);
      const countBeforeTask = outbound().length;
      const dueRequest = provider.holdRequest("due-orders");
      try {
        // The due run has already reached inference under its admitted permissions.
        await adapter.waitForCondition(() => dueRequest.reached || null, 155_000);
        await patchSearch(true);
      } finally {
        dueRequest.release();
      }
      const summary = await adapter
        .waitForOutbound({
          sinceIndex: countBeforeTask,
          textIncludes: "You have 2 orders for 11 units.",
          timeoutMs: 45_000,
        })
        .catch(async (error) => {
          throw new Error(
            JSON.stringify({
              run: await gateway.call("cron.runs", { id: task.id }),
              capture: await gateway.call("cron.list", { includeDisabled: true }),
              surface: provider.surfaces.get("due-orders"),
              result: provider.results.get("due-orders"),
              recent: outbound()
                .slice(countBeforeTask)
                .map((message) => message.text),
              diagnostics: provider.diagnostics("due-orders"),
            }),
            { cause: error },
          );
        });
      await completed(task.id, "ok");
      assert.deepEqual(provider.inferenceAccounts.get("due-orders"), new Set(["original"]));
      assert.equal(summary.conversation.id, replyPeers.get(alice));
      assert.equal(summary.accountId, adapter.accountId);
      assert.deepEqual(JSON.parse(provider.results.get("due-orders")!), { quantities: [3, 8] });
      assert.ok(provider.surfaces.get("due-orders")?.includes("qa_my_orders"));
      assert.equal(provider.surfaces.get("due-orders")?.includes("gateway"), false);
      provider.requestedTools.set("due-review", "qa_my_orders");
      provider.requests.set("due-review", { action: "mark_reviewed" });
      const write = JSON.parse(
        await ask(alice, "schedule-review", {
          action: "add",
          mode: "task",
          text: "Mark my orders reviewed. [automation-proof:due-review]",
          schedule: { kind: "at", at: new Date(Date.now() + 20_000).toISOString() },
        }),
      );
      const trimmed = (await gateway.call("sessions.compact", { key: chatKey, maxLines: 2 })) as {
        compacted: boolean;
        key: string;
      };
      assert.ok(trimmed.compacted);
      assert.equal(trimmed.key, chatKey);
      const receipt = await adapter.waitForOutbound({
        sinceIndex: outbound().length,
        textIncludes: "Marked 2 orders reviewed.",
        timeoutMs: 60_000,
      });
      await completed(write.id, "ok");
      assert.deepEqual(provider.inferenceAccounts.get("due-review"), new Set(["alternate"]));
      assert.equal(receipt.accountId, adapter.accountId);
      assert.equal(receipt.conversation.id, replyPeers.get(alice));
      assert.deepEqual(JSON.parse((await readFile(ordersFile + ".reviews", "utf8")).trim()), {
        account: adapter.accountId,
        peer: "+15550000001",
        quantities: [3, 8],
      });
      const readAccesses = () => readFile(ordersFile + ".accesses", "utf8");
      const accesses = await readAccesses();
      assert.deepEqual(
        accesses
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [
          { account: adapter.accountId, peer: "+15550000001", action: "list" },
          { account: adapter.accountId, peer: "+15550000001", action: "list" },
          { account: adapter.accountId, peer: "+15550000001", action: "mark_reviewed" },
        ],
      );
      const beforeDisconnect = outbound().length;
      await gateway.restartAfterStateMutation(async ({ stateDir }) => {
        await writeQaAuthProfiles({
          stateDir,
          agentId: "qa",
          replace: true,
          profiles: {
            alternate: { type: "api_key", provider: "mock-openai", key: accounts.alternate },
          },
        });
      });
      await adapter.waitReady({ gateway });
      await gateway.call("cron.run", { id: task.id, mode: "force" });
      await completed(task.id, "error");
      const runs = (await gateway.call("cron.runs", { id: task.id })) as {
        entries: { status: string; error?: string }[];
      };
      assert.match(
        runs.entries.find((entry) => entry.status === "error")?.error ?? "",
        /account original|inference account|authorization was disconnected/i,
      );
      assert.equal(await readAccesses(), accesses);
      await adapter.waitForNoOutbound({ sinceIndex: beforeDisconnect });
      const config = (await gateway.call("config.get", {})) as { hash: string };
      await gateway.call("config.patch", {
        baseHash: config.hash,
        replacePaths: [`channels.whatsapp.accounts.${adapter.accountId}.allowFrom`],
        raw: JSON.stringify({
          channels: {
            whatsapp: {
              accounts: { [adapter.accountId]: { allowFrom: ["+15550000003", "+15550000002"] } },
            },
          },
        }),
      });
      const beforeRevokedRun = outbound().length;
      await gateway.call("cron.run", { id: task.id, mode: "force" });
      await completed(task.id, "skipped");
      await adapter.waitForNoOutbound({ sinceIndex: beforeRevokedRun });
      provider.requests.set("after-revoke", {
        action: "add",
        text: "Not scheduled",
        schedule: { kind: "every", everyMs: 3_600_000 },
      });
      await adapter.sendInbound({
        accountId: adapter.accountId,
        conversation: { id: alice, kind: "direct" },
        senderId: alice,
        text: "Set a reminder [automation-proof:after-revoke]",
      });
      await adapter.waitForNoOutbound({ sinceIndex: beforeRevokedRun });
      assert.equal(provider.toolAvailability.has("after-revoke"), false);
      assert.equal(await readAccesses(), accesses);
      assert.deepEqual(
        (await readJobs()).map((j) => j.id).toSorted(),
        [...before.map((j) => j.id), task.id].toSorted(),
      );
      await gateway.call("cron.remove", { id: task.id });
      assert.deepEqual(await readJobs(), before);
    },
    () => stopQaGatewayFixture(owner),
    () => transport?.cleanupAfterGatewayStop(),
    () => reports?.close(),
    () => provider.stop(),
  );
}
await run();
