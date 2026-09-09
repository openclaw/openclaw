import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractLastMatchingUserTurn,
  extractToolOutput,
  extractToolOutputCallId,
  hasToolOutput,
} from "./providers/mock-openai/mock-openai-input.ts";
import { buildToolCallEventsWithArgs } from "./providers/mock-openai/mock-openai-tooling.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cross-channel automation management with a real Gateway",
  startServerBeforeBrowser: true,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type AutomationAction = "list" | "get" | "update" | "run" | "remove";
const actions = ["list", "get", "update", "run", "remove"] as const;
const automationName = "Telegram-created reminder";
const updatedReminderMessage = "Complete the reminder updated from Control UI.";
const scheduledReply = "Scheduled reminder completed.";

function readResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Automation tool returned no object result");
  }
  return value;
}

async function startAutomationProvider() {
  const requests = new Map<string, Record<string, unknown>>();
  const results = new Map<string, string>();
  const terminalReplies = new Set<string>();
  const issuedCalls = new Map<string, string>();
  const exchanges: Array<{ marker?: string; request: unknown; events: unknown[] }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body) || !Array.isArray(body.input)) {
        throw new Error("Expected a Responses request");
      }
      const input = body.input.filter(isRecord);
      const taggedTurn = extractLastMatchingUserTurn(input, /\[automation-proof:/u);
      const marker = /\[automation-proof:([a-z-]+)\]/u.exec(
        taggedTurn?.text ?? extractLastUserText(input),
      )?.[1];
      const args = marker ? requests.get(marker) : undefined;
      const output = extractToolOutput(input);
      if (
        marker &&
        args &&
        hasToolOutput(input) &&
        extractToolOutputCallId(input) === issuedCalls.get(marker)
      ) {
        results.set(marker, output);
      }
      const events =
        args && !hasToolOutput(input) && !(marker && issuedCalls.has(marker))
          ? buildToolCallEventsWithArgs("automations", args)
          : buildAssistantEvents(
              marker && terminalReplies.has(marker)
                ? []
                : marker && args
                  ? `${marker}: ${output}`
                  : scheduledReply,
            );
      for (const event of events) {
        if (
          marker &&
          event.type === "response.output_item.added" &&
          isRecord(event.item) &&
          event.item.type === "function_call" &&
          typeof event.item.call_id === "string"
        ) {
          issuedCalls.set(marker, event.item.call_id);
        }
      }
      exchanges.push({ marker, request: body, events });
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } else {
        const completed = events.find((event) => event.type === "response.completed");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completed?.response));
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Automation provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    results,
    terminalReplies,
    exchanges,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function managementArgs(action: AutomationAction, jobId: string) {
  return {
    action,
    ...(action === "list" ? { includeDisabled: true } : { jobId }),
    ...(action === "update"
      ? {
          job: {
            name: "Reminder updated from Control UI",
            payload: { message: updatedReminderMessage },
          },
        }
      : {}),
    ...(action === "run" ? { runMode: "force" } : {}),
  };
}

suite.define(() => {
  it(
    "keeps restricted inventory scope in the public terminal fallback",
    { timeout: 240_000 },
    async () => {
      const proofDir = suite.artifactDir;
      const provider = await startAutomationProvider();
      const owner = createQaGatewayChild();
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          providerBaseUrl: provider.baseUrl,
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          forcedRuntime: "openclaw",
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          mutateConfig: (cfg) => ({
            ...cfg,
            cron: { ...cfg.cron, enabled: false },
            plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } },
            memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
            tools: { profile: "full", allow: ["automations"], codeMode: false, toolSearch: false },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  tools: { profile: "full", allow: ["automations"] },
                },
              },
            },
          }),
        });
        const initialAdminList = await gateway.call("cron.list", { includeDisabled: true });
        if (!isRecord(initialAdminList) || typeof initialAdminList.total !== "number") {
          throw new Error("Expected the initial administrator inventory");
        }
        const initialAdminTotal = initialAdminList.total;
        const visible = await gateway.call("cron.add", {
          name: "Visible scope control",
          agentId: "qa",
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Visible synthetic control." },
        });
        const hidden = await gateway.call("cron.add", {
          name: "Hidden scope control",
          agentId: "qa",
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Hidden synthetic control." },
          delivery: { mode: "none" },
        });
        if (!isRecord(visible) || !isRecord(hidden)) {
          throw new Error("Expected created automations");
        }
        const adminList = await gateway.call("cron.list", { includeDisabled: true });
        await writeFile(
          path.join(proofDir, "seed-and-admin.json"),
          JSON.stringify({ initialAdminList, visible, hidden, adminList }, null, 2),
        );
        expect(adminList).toMatchObject({ total: initialAdminTotal + 2 });
        if (!isRecord(adminList) || !Array.isArray(adminList.jobs)) {
          throw new Error("Expected administrator list rows");
        }
        const adminIds = adminList.jobs.filter(isRecord).map((job) => job.id);
        const adminModes: unknown[] = [];
        for (const options of [
          { compact: true },
          { includeDeliveryPreviews: false },
          { includeDeliveryPreviews: true },
        ]) {
          const mode = await gateway.call("cron.list", { includeDisabled: true, ...options });
          adminModes.push({ options, result: mode });
          await writeFile(
            path.join(proofDir, "admin-list-modes.json"),
            JSON.stringify(adminModes, null, 2),
          );
          expect(mode).toMatchObject({
            total: initialAdminTotal + 2,
            snapshotRevision: adminList.snapshotRevision,
          });
          expect(mode).not.toHaveProperty("scopeHint");
          if (!isRecord(mode) || !Array.isArray(mode.jobs)) {
            throw new Error("Expected projected list rows");
          }
          expect(mode.jobs.filter(isRecord).map((job) => job.id)).toEqual(adminIds);
        }

        const observations: Array<{
          restricted: boolean;
          scopes: unknown;
          result: Record<string, unknown>;
          text: string;
          visibleText: string | null;
          frames: unknown[];
        }> = [];
        for (const restricted of [true, false]) {
          const marker = restricted ? "restricted-terminal" : "admin-terminal";
          const sessionKey = `agent:qa:dashboard:scope-${randomUUID()}`;
          await gateway.call("sessions.create", {
            key: sessionKey,
            label: `Automation scope ${marker}`,
          });
          provider.requests.set(marker, { action: "list", includeDisabled: true });
          provider.terminalReplies.add(marker);
          await suite.withPage(
            {
              locale: "en-US",
              serviceWorkers: "block",
            },
            async ({ page }) => {
              const frames: unknown[] = [];
              const sent: unknown[] = [];
              page.on("websocket", (socket) => {
                socket.on("framereceived", ({ payload }) =>
                  frames.push(JSON.parse(payload.toString())),
                );
                socket.on("framesent", ({ payload }) => sent.push(JSON.parse(payload.toString())));
              });
              await page.addInitScript(
                ({ gatewayUrl, token, restricted: callerScoped }) => {
                  window.localStorage.setItem(
                    "openclaw:control-ui:community-invite",
                    JSON.stringify({ dismissedAtMs: 1770000000000 }),
                  );
                  const client = callerScoped
                    ? {
                        id: "webchat-ui",
                        mode: "webchat",
                        platform: "web",
                        deviceFamily: "desktop",
                        scopes: ["operator.admin", "operator.read", "operator.write"],
                      }
                    : undefined;
                  Object.assign(window, {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__: { gatewayUrl, token, client },
                  });
                },
                { gatewayUrl: gateway.wsUrl, token: gateway.token, restricted },
              );
              await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
              const readHello = () =>
                frames
                  .filter(isRecord)
                  .find((frame) => isRecord(frame.payload) && frame.payload.type === "hello-ok");
              await expect.poll(readHello, { timeout: 60_000 }).toBeTruthy();
              const hello = readHello();
              await writeFile(
                path.join(proofDir, `${marker}-handshake.json`),
                JSON.stringify(frames, null, 2),
              );
              if (!hello || !isRecord(hello.payload) || !isRecord(hello.payload.auth)) {
                throw new Error("Missing public handshake scopes");
              }
              const scopes = hello.payload.auth.scopes;
              expect(Array.isArray(scopes)).toBe(true);
              expect(scopes).toContain("operator.admin");
              expect(
                sent.filter(isRecord).find((frame) => frame.method === "connect"),
              ).toMatchObject({
                params: { client: { id: restricted ? "webchat-ui" : "openclaw-control-ui" } },
              });
              await page
                .locator(".agent-chat__composer-combobox textarea")
                .fill(`List all automations. [automation-proof:${marker}]`);
              await page.getByRole("button", { name: "Send message" }).click();
              await expect.poll(() => provider.results.has(marker), { timeout: 60_000 }).toBe(true);
              const result = readResult(provider.results.get(marker) ?? "null");
              const request = sent
                .filter(isRecord)
                .find(
                  (frame) =>
                    frame.method === "chat.send" &&
                    isRecord(frame.params) &&
                    frame.params.sessionKey === sessionKey,
                );
              if (!request) {
                throw new Error("Missing composer chat.send request");
              }
              const ack = frames
                .filter(isRecord)
                .find((frame) => frame.type === "res" && frame.id === request.id);
              if (!ack || !isRecord(ack.payload) || typeof ack.payload.runId !== "string") {
                throw new Error("Missing matching chat.send ACK");
              }
              const runId = ack.payload.runId;
              const readTerminal = () =>
                frames
                  .filter(isRecord)
                  .filter(
                    (frame) =>
                      frame.type === "event" &&
                      frame.event === "chat" &&
                      isRecord(frame.payload) &&
                      frame.payload.sessionKey === sessionKey &&
                      frame.payload.runId === runId &&
                      ["final", "aborted", "error"].includes(String(frame.payload.state)),
                  )
                  .map((frame) => frame.payload)
                  .filter(isRecord);
              await expect
                .poll(
                  () =>
                    readTerminal().some(
                      (event) => event.state === "error" && typeof event.errorMessage === "string",
                    ),
                  { timeout: 60_000 },
                )
                .toBe(true);
              const terminals = readTerminal();
              const text = terminals
                .flatMap((event) => {
                  if (event.state === "error") {
                    return typeof event.errorMessage === "string" ? [event.errorMessage] : [];
                  }
                  if (
                    !isRecord(event.message) ||
                    event.message.role !== "assistant" ||
                    !Array.isArray(event.message.content)
                  ) {
                    return [];
                  }
                  return event.message.content
                    .filter(isRecord)
                    .filter((block) => block.type === "text" && typeof block.text === "string")
                    .map((block) => String(block.text));
                })
                .join("\n");
              await writeFile(
                path.join(proofDir, `${marker}-events.json`),
                JSON.stringify({ request, ack, terminals, frames, result }, null, 2),
              );
              await page
                .locator(".chat-error, .chat-text")
                .filter({ hasText: "Automations listed." })
                .first()
                .waitFor({ timeout: 10_000 });
              const diagnostics = page.locator(".chat-error details");
              for (const detail of await diagnostics.all()) {
                if ((await detail.getAttribute("open")) === null) {
                  await detail.locator("summary").click();
                }
              }
              const terminalElement = page
                .locator(".chat-text, .chat-error__diagnostic")
                .filter({ hasText: "Automations listed." })
                .last();
              await terminalElement.waitFor({ state: "visible", timeout: 10_000 });
              const visibleText = await terminalElement.textContent();
              await page.screenshot({ path: path.join(proofDir, `${marker}-terminal.png`) });
              observations.push({ restricted, scopes, result, text, visibleText, frames });
              await writeFile(
                path.join(proofDir, `${marker}.json`),
                JSON.stringify(observations.at(-1), null, 2),
              );
              await writeFile(
                path.join(proofDir, `${marker}-history.json`),
                JSON.stringify(await gateway.call("chat.history", { sessionKey }), null, 2),
              );
              if (restricted) {
                const queries: Array<{ marker: string; result: Record<string, unknown> }> = [];
                const queryList = async (queryMarker: string, args: Record<string, unknown>) => {
                  provider.requests.set(queryMarker, {
                    action: "list",
                    includeDisabled: true,
                    ...args,
                  });
                  await page
                    .locator(".agent-chat__composer-combobox textarea")
                    .fill(`List automations. [automation-proof:${queryMarker}]`);
                  await page.getByRole("button", { name: "Send message" }).click();
                  await expect
                    .poll(() => provider.results.has(queryMarker), { timeout: 60_000 })
                    .toBe(true);
                  await page
                    .locator(".chat-text")
                    .filter({ hasText: `${queryMarker}:` })
                    .last()
                    .waitFor({ state: "visible", timeout: 60_000 });
                  expect(await page.locator(".chat-error").count()).toBe(0);
                  const output = provider.results.get(queryMarker);
                  if (output === undefined) {
                    throw new Error("Missing matching tool output");
                  }
                  const queryResult = readResult(output);
                  queries.push({ marker: queryMarker, result: queryResult });
                  await writeFile(
                    path.join(proofDir, "caller-list-controls.json"),
                    JSON.stringify(queries, null, 2),
                  );
                  expect(queryResult).toMatchObject({
                    scope: "caller",
                    scopeHint: result.scopeHint,
                  });
                  expect(JSON.stringify(queryResult)).not.toContain(String(hidden.id));
                  return queryResult;
                };
                const firstPage = await queryList("restricted-page-one", { limit: 1, offset: 0 });
                const secondPage = await queryList("restricted-page-two", { limit: 1, offset: 1 });
                expect(firstPage).toMatchObject({
                  total: result.total,
                  offset: 0,
                  nextOffset: 1,
                  snapshotRevision: result.snapshotRevision,
                });
                expect(secondPage).toMatchObject({
                  total: result.total,
                  offset: 1,
                  nextOffset: null,
                  snapshotRevision: result.snapshotRevision,
                });
                if (!Array.isArray(firstPage.jobs) || !Array.isArray(secondPage.jobs)) {
                  throw new Error("Expected caller pages");
                }
                expect([...firstPage.jobs, ...secondPage.jobs]).toEqual(result.jobs);
                const changedHidden = await gateway.call("cron.update", {
                  id: hidden.id,
                  patch: { name: "Changed hidden scope control" },
                });
                expect(changedHidden).toMatchObject({
                  id: hidden.id,
                  name: "Changed hidden scope control",
                });
                const afterHiddenUpdate = await queryList("restricted-after-hidden-update", {});
                expect(afterHiddenUpdate).toEqual(result);
                const enabledOnly = await queryList("restricted-enabled", {
                  includeDisabled: false,
                });
                if (!Array.isArray(enabledOnly.jobs)) {
                  throw new Error("Expected enabled caller rows");
                }
                if (!Array.isArray(result.jobs)) {
                  throw new Error("Expected caller inventory rows");
                }
                const enabledRows = result.jobs.filter(
                  (job) => isRecord(job) && job.enabled === true,
                );
                expect(enabledOnly.jobs).toEqual(enabledRows);
                expect(enabledOnly.total).toBe(enabledRows.length);
              }
            },
          );
        }
        await writeFile(
          path.join(proofDir, "provider-exchanges.json"),
          JSON.stringify(provider.exchanges, null, 2),
        );
        const restricted = observations.find((item) => item.restricted);
        const admin = observations.find((item) => !item.restricted);
        if (!restricted || !admin) {
          throw new Error("Missing terminal observations");
        }
        expect(restricted.result).toMatchObject({ scope: "caller" });
        expect(restricted.result.jobs).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: visible.id })]),
        );
        expect(JSON.stringify(restricted.result)).not.toContain(String(hidden.id));
        const restrictedTotal = restricted.result.total;
        const scopeHint = restricted.result.scopeHint;
        if (typeof restrictedTotal !== "number" || typeof scopeHint !== "string") {
          throw new Error("Missing canonical restricted result metadata");
        }
        expect(restricted.result.jobs).toHaveLength(restrictedTotal);
        expect(restricted.text).toContain(`Count: ${restrictedTotal}`);
        expect(scopeHint).toContain("Restricted automation inventory");
        expect(restricted.text).toContain(scopeHint);
        expect(admin.result).toMatchObject({ total: initialAdminTotal + 2, scope: "gateway" });
        expect(admin.result).not.toHaveProperty("scopeHint");
        expect(admin.text).toContain(`Count: ${initialAdminTotal + 2}`);
        expect(admin.text).not.toContain("Restricted automation inventory");
        expect(restricted.visibleText).toContain(`Count: ${restrictedTotal}`);
        expect(restricted.visibleText).toContain(scopeHint);
        expect(admin.visibleText).toContain(`Count: ${initialAdminTotal + 2}`);
        expect(admin.visibleText).not.toContain("Restricted automation inventory");
      } catch (error) {
        errors.push(error);
      }
      await writeFile(
        path.join(proofDir, "provider-exchanges.json"),
        JSON.stringify(provider.exchanges, null, 2),
      );
      const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      try {
        await provider.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        throw new AggregateError(errors, "Automation scope terminal proof failed");
      }
    },
  );

  it(
    "admin chat manages a Telegram-created job while another Telegram caller is denied",
    {
      timeout: 240_000,
    },
    async () => {
      const proofDir = suite.artifactDir;
      const provider = await startAutomationProvider();
      const owner = createQaGatewayChild();
      const transport = await createQaCrablineTransportAdapter({
        outputDir: proofDir,
        selection: {
          channel: "telegram",
          channelDriver: "crabline",
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          providerBaseUrl: provider.baseUrl,
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          forcedRuntime: "openclaw",
          transport,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          mutateConfig: (cfg) => ({
            ...cfg,
            // Both channel senders may use automation tools; neither is a Control UI administrator.
            commands: { ...cfg.commands, ownerAllowFrom: ["telegram:100001", "telegram:100002"] },
            session: { ...cfg.session, dmScope: "per-channel-peer" },
            plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } },
            memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
            tools: { profile: "full", allow: ["automations"], codeMode: false, toolSearch: false },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  identity: { name: "Automation proof" },
                  tools: { profile: "full", allow: ["automations"] },
                },
              },
            },
          }),
        });
        await transport.waitReady({ gateway });
        provider.requests.set("create", {
          action: "add",
          job: {
            name: automationName,
            enabled: false,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Complete this synthetic reminder." },
            delivery: { mode: "none" },
          },
        });
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: { id: "100001", kind: "direct" },
          senderId: "100001",
          text: "Create a disabled hourly reminder. [automation-proof:create]",
        });
        await transport.waitForOutbound({ textIncludes: "create:", timeoutMs: 60_000 });
        const created = readResult(provider.results.get("create") ?? "null");
        expect(created).toMatchObject({
          name: automationName,
          owner: { sessionKey: expect.stringContaining(":telegram:") },
          scheduledToolPolicy: { mode: "account" },
          payload: {
            kind: "agentTurn",
            toolsAllow: expect.arrayContaining(["automations"]),
            toolsAllowIsDefault: true,
          },
        });
        if (!isRecord(created.payload)) {
          throw new Error("Created automation has no payload");
        }
        const creatorPayload = created.payload;
        expect(typeof created.id).toBe("string");
        const jobId = String(created.id);
        const channelResults: Record<string, string> = {};
        for (const action of actions) {
          const marker = `channel-${action}`;
          provider.requests.set(marker, managementArgs(action, jobId));
          const outboundIndex = transport.state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound").length;
          await transport.sendInbound({
            accountId: transport.accountId,
            conversation: { id: "100002", kind: "direct" },
            senderId: "100002",
            text: `Manage the other conversation's reminder. [automation-proof:${marker}]`,
          });
          const reply = await transport.waitForOutbound({
            textIncludes: `${marker}:`,
            sinceIndex: outboundIndex,
            timeoutMs: 60_000,
          });
          const output = provider.results.get(marker) ?? "";
          if (action === "list") {
            expect(readResult(output).jobs).not.toEqual(
              expect.arrayContaining([expect.objectContaining({ id: jobId })]),
            );
          } else {
            expect(output).toMatch(/not found|denied|not authorized|not accessible/iu);
            expect(output).toMatch(/list automations|Control UI|retry/iu);
          }
          expect(reply.text.replace(/\s+/gu, " ")).toContain(output.replace(/\s+/gu, " "));
          channelResults[action] = action === "list" ? "hidden" : "denied visibly";
        }

        const sessionKey = `agent:qa:dashboard:automation-management-${randomUUID()}`;
        await gateway.call("sessions.create", {
          key: sessionKey,
          label: "Manage Telegram reminder",
        });
        const adminResults: Record<string, string> = {};
        await suite.withPage(
          {
            locale: "en-US",
            ...(captureUiProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
            viewport: { width: 1280, height: 900 },
            serviceWorkers: "block",
          },
          async ({ page }) => {
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.wsUrl, token: gateway.token },
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            for (const action of actions) {
              const marker = `admin-${action}`;
              provider.requests.set(marker, managementArgs(action, jobId));
              await page
                .locator(".agent-chat__composer-combobox textarea")
                .fill(`${action} the Telegram-created reminder. [automation-proof:${marker}]`);
              if (captureUiProof) {
                await page.screenshot({ path: path.join(proofDir, `${marker}-request.png`) });
              }
              await page.getByRole("button", { name: "Send message" }).click();
              await expect.poll(() => provider.results.has(marker), { timeout: 60_000 }).toBe(true);
              const result = readResult(provider.results.get(marker) ?? "null");
              if (action === "list") {
                expect(result.jobs).toEqual(
                  expect.arrayContaining([expect.objectContaining({ id: jobId })]),
                );
              } else if (action === "get") {
                expect(result).toMatchObject({ id: jobId, name: automationName });
              } else if (action === "update") {
                const updatedJob = {
                  id: jobId,
                  name: "Reminder updated from Control UI",
                  payload: { ...creatorPayload, message: updatedReminderMessage },
                  owner: created.owner,
                  scheduledToolPolicy: created.scheduledToolPolicy,
                };
                expect(result).toEqual(expect.objectContaining(updatedJob));
                expect(await gateway.call("cron.get", { id: jobId })).toEqual(
                  expect.objectContaining(updatedJob),
                );
              } else if (action === "run") {
                expect(result).toMatchObject({ ok: true });
                await expect
                  .poll(
                    async () => {
                      const runs = await gateway.call("cron.runs", { id: jobId });
                      return (
                        isRecord(runs) &&
                        Array.isArray(runs.entries) &&
                        runs.entries.some((entry) => isRecord(entry) && entry.status === "ok")
                      );
                    },
                    { timeout: 60_000 },
                  )
                  .toBe(true);
              } else {
                expect(result).toMatchObject({ removed: true });
              }
              await page
                .getByText(new RegExp(`^${marker}:`, "u"))
                .first()
                .waitFor();
              if (captureUiProof) {
                await page.screenshot({ path: path.join(proofDir, `${marker}-result.png`) });
              }
              adminResults[action] = "succeeded";
            }
          },
        );
        const auditEvents = gateway
          .logs()
          .split("\n")
          .filter((line) => line.includes("cron: admin management"));
        expect(auditEvents).toHaveLength(actions.length);
        await writeFile(
          path.join(proofDir, "verdict.json"),
          `${JSON.stringify(
            {
              gateway: "real isolated Gateway",
              channel: "real Telegram plugin with synthetic Crabline Bot API",
              provider: "deterministic local Responses API",
              creator: "Telegram conversation",
              admin: adminResults,
              otherTelegramConversation: channelResults,
              adminManagementAuditEvents: auditEvents.length,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        errors.push(error);
      }
      const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      for (const stop of [() => transport.cleanup(), () => provider.stop()]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Cross-channel automation management proof failed");
      }
    },
  );
});
