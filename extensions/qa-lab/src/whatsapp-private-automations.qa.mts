import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";

async function run() {
  const outputDir = await mkdtemp(path.join(homedir(), "whatsapp-qa-"));
  console.log("QA output", outputDir);
  const provider = await startAutomationProvider("whatsapp_automations");
  const owner = createQaGatewayChild();
  let transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>> | undefined;
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
          const tools = {
            profile: "full" as const,
            allow: ["whatsapp_automations", "session_status", "qa_my_orders"],
          };
          cfg.tools = {
            ...tools,
            codeMode: false,
            toolSearch: false,
            gatewayPolicy: {
              allow: ["whatsapp_automations", "session_status", "qa_my_orders"],
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
      async function completed(id: string, status: string) {
        await adapter.waitForCondition(async () => {
          const page = (await gateway.call("cron.runs", { id })) as {
            entries: { status: string }[];
          };
          return page.entries.some((entry) => entry.status === status) || null;
        }, 45_000);
      }
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
      await setOrders([3, 8]);
      const countBeforeTask = outbound().length;
      const summary = await adapter
        .waitForOutbound({
          sinceIndex: countBeforeTask,
          textIncludes: "You have 2 orders for 11 units.",
          timeoutMs: 155_000,
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
          schedule: { kind: "at", at: new Date(Date.now() + 12_000).toISOString() },
        }),
      );
      const receipt = await adapter.waitForOutbound({
        sinceIndex: outbound().length,
        textIncludes: "Marked 2 orders reviewed.",
        timeoutMs: 60_000,
      });
      await completed(write.id, "ok");
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
    () => provider.stop(),
  );
}
await run();
