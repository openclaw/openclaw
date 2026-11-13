// Manual qualification of an authentic released UI, not a Gateway/provider process upgrade.
// node --import ./scripts/tsx.mjs scripts/proof-control-ui-goal-upgrade.ts
//   --stable-tarball <official openclaw-2026.11.1.tgz> --out <new proof directory>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Page } from "playwright";
import { createSessionGoalFixture } from "../src/gateway/session-goal.test-support.js";
import {
  buildProductionControlUiE2e,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../ui/src/test-helpers/control-ui-session-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const stableVersion = "2026.11.1";
const stableTagObject = "08d4ded27a1de5af3b60734f7673d4cb594efe78";
const stableCommit = "4ffdd2047d192dd65554de3c8c46c0e0197c6e2a";
// Observed in the authentic released client's connect frame, not injected into the client.
const stableBuildId = "2026.11.1-release-4ffdd2047d19-2026-11-05T01-26-26.075Z";
const stableTarballSha256 = "611282534d576e12f10b0ac5a1ac0d2825aac360637e92815a56eb71fb5a0301";
const composer = ".agent-chat__composer-combobox textarea";
const goalMode = ".agent-chat__goal-mode";
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

async function entry(dir: string) {
  const html = await readFile(path.join(dir, "index.html"), "utf8");
  const match = /<script[^>]*src="([^"]+)"/.exec(html);
  assert(match?.[1]);
  const source = match[1];
  const asset = source.startsWith("./")
    ? source.slice(2)
    : source.startsWith("/")
      ? source.slice(1)
      : source;
  return {
    source,
    asset,
    indexSha256: hash(html),
    entrySha256: hash(await readFile(path.join(dir, asset))),
  };
}

async function load(
  page: Page,
  baseUrl: string,
  expected: Awaited<ReturnType<typeof entry>>,
  reload: boolean,
) {
  const response = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/" + expected.asset),
  );
  if (reload) {
    await page.reload();
  } else {
    await page.goto(baseUrl + "chat/main");
  }
  assert.equal(
    hash(await (await response).body()),
    expected.entrySha256,
    "browser must execute the selected authentic bundle",
  );
  assert.equal(await page.locator("script[src]").first().getAttribute("src"), expected.source);
  await page.locator(composer).waitFor({ state: "visible", timeout: 20_000 });
}

async function value(page: Page, text: string, editing: boolean) {
  await page.waitForFunction(
    ({ selector, text: expectedText }) =>
      document.querySelector<HTMLTextAreaElement>(selector)?.value === expectedText,
    { selector: composer, text },
  );
  assert.equal(await page.locator(composer).inputValue(), text);
  assert.equal(await page.locator(goalMode).count(), editing ? 1 : 0);
}

async function waitForStableSessionSnapshot(page: Page, text: string) {
  // Read only: wait for the released client to publish its own debounced session snapshot.
  // Reload and the fresh-page consumer assertions separately prove persistence across clients.
  await page.waitForFunction(
    (expectedText) =>
      Object.values(sessionStorage).some((storedSnapshot) =>
        storedSnapshot.includes(JSON.stringify(expectedText)),
      ),
    text,
  );
}

async function main() {
  const { values } = parseArgs({
    options: { "stable-tarball": { type: "string" }, out: { type: "string" } },
  });
  const tarball = values["stable-tarball"],
    output = values.out;
  assert(tarball && output, "--stable-tarball and --out are required");
  const out = path.resolve(output);
  await mkdir(out);
  assert.equal(hash(await readFile(tarball)), stableTarballSha256);
  assert.equal(
    execFileSync("git", ["rev-parse", stableTagObject + "^{commit}"], {
      encoding: "utf8",
      cwd: repoRoot,
    }).trim(),
    stableCommit,
  );
  const extracted = path.join(out, "release");
  await mkdir(extracted);
  execFileSync("tar", [
    "-xzf",
    path.resolve(tarball),
    "-C",
    extracted,
    "package/package.json",
    "package/dist/control-ui",
  ]);
  const pkg: unknown = JSON.parse(
    await readFile(path.join(extracted, "package/package.json"), "utf8"),
  );
  assert(isRecord(pkg));
  assert.equal(pkg.version, stableVersion);
  const stableDir = path.join(extracted, "package/dist/control-ui");
  const currentDir = path.join(out, "current");
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
  const currentBuildId = "goal-upgrade-" + currentCommit + "-" + Date.now();
  await buildProductionControlUiE2e(currentDir, currentBuildId);
  const stableEntry = await entry(stableDir),
    currentEntry = await entry(currentDir);
  assert.notEqual(stableEntry.entrySha256, currentEntry.entrySha256);
  const cases: Record<string, unknown>[] = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  try {
    for (const kind of ["ordinary", "start", "edit-cancel", "edit-submit"] as const) {
      console.log("Starting authentic stable producer:", kind);
      const now = Date.now(),
        editing = kind.startsWith("edit");
      const ordinary = "Ordinary stable draft before editing. Keep  these spaces.";
      const objective =
        kind === "start"
          ? "/goal clear\nKeep  the stable objective literal.  "
          : "/goal clear\nKeep  the stable edit literal.";
      const expected = kind === "ordinary" ? ordinary : objective;
      const goal = createSessionGoalFixture("stable-upgrade-goal", "Original server Goal", {
        status: "paused",
        createdAt: now,
        updatedAt: now,
        pausedAt: now,
      });
      const scenario = {
        serverBuildId: stableBuildId,
        sessionKey: "agent:main:main",
        agentModel: "test/objective-model",
        models: [{ id: "objective-model", name: "Objective model", provider: "test" }],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Stable upgrade proof", now, {
            sessionId: "stable-upgrade-session",
            model: "objective-model",
            modelProvider: "test",
            ...(editing ? { goal } : {}),
          }),
        ],
        heldMethods: kind === "edit-submit" ? ["sessions.goal.update"] : [],
      };
      const served = path.join(out, "served-" + kind);
      await cp(stableDir, served, { recursive: true });
      let server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>> | undefined =
        await startBuiltControlUiE2eServer(served, createControlUiMockBootstrapConfig(scenario));
      const baseUrl = server.baseUrl;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // Native network cannot reach a real Gateway/provider; only the synthetic transport is used.
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      let page = await context.newPage();
      let gateway = await installMockGateway(page, scenario);
      try {
        await load(page, baseUrl, stableEntry, false);
        const stableConnect = (await gateway.getRequests("connect"))[0];
        assert(isRecord(stableConnect?.params) && isRecord(stableConnect.params.client));
        assert.equal(stableConnect.params.client.version, stableVersion);
        assert.equal(stableConnect.params.client.buildId, stableBuildId);
        let input = page.locator(composer);
        if (editing) {
          await input.fill(ordinary);
          await page.getByRole("button", { name: "Edit goal", exact: true }).click();
          await value(page, goal.objective, true);
          await page.getByRole("button", { name: "Save goal", exact: true }).waitFor();
        } else if (kind === "start") {
          await input.fill("/goal start ");
          await page.locator(goalMode).waitFor();
          assert.equal(await input.inputValue(), "");
        }
        await input.fill(expected);
        await value(page, expected, kind !== "ordinary");
        await input.press("Tab");
        await waitForStableSessionSnapshot(page, expected);
        await load(page, baseUrl, stableEntry, true);
        await value(page, expected, kind !== "ordinary");
        if (editing) {
          assert.equal(
            await page.getByRole("button", { name: "Save goal", exact: true }).count(),
            1,
          );
        }
        if (kind === "edit-cancel") {
          await page.screenshot({ path: path.join(out, "stable-edit-draft.png") });
        }

        // Upgrade only task-owned serving/runtime resources, preserving this browser context/origin.
        const origin = new URL(page.url()).origin;
        await page.close();
        await server.close();
        server = undefined;
        const next = path.join(out, "next-" + kind);
        await cp(currentDir, next, { recursive: true });
        const currentScenario = { ...scenario, serverBuildId: currentBuildId };
        server = await startBuiltControlUiE2eServer(
          next,
          createControlUiMockBootstrapConfig(currentScenario),
          Number(new URL(baseUrl).port),
        );
        assert.equal(server.baseUrl, baseUrl);
        page = await context.newPage();
        gateway = await installMockGateway(page, currentScenario);
        await load(page, baseUrl, currentEntry, false);
        await load(page, baseUrl, currentEntry, true);
        assert.equal(new URL(page.url()).origin, origin);
        const currentConnect = (await gateway.getRequests("connect"))[0];
        assert(isRecord(currentConnect?.params) && isRecord(currentConnect.params.client));
        assert.equal(currentConnect.params.client.buildId, currentBuildId);
        input = page.locator(composer);
        await value(page, expected, kind !== "ordinary");
        const record: Record<string, unknown> = {
          kind,
          origin,
          sessionKey: scenario.sessionKey,
          stableSessionSnapshotObserved: true,
          stableReloadPreserved: true,
          currentReloadPreserved: true,
          draftStorageCopiedOrInjected: false,
        };
        if (kind === "edit-cancel") {
          await input.press("Escape");
          await value(page, ordinary, false);
          assert.equal((await gateway.getRequests("sessions.goal.update")).length, 0);
          await load(page, baseUrl, currentEntry, true);
          await value(page, ordinary, false);
          await page.screenshot({ path: path.join(out, "current-edit-cancelled.png") });
          record.cancellationRestoredOriginalOrdinaryDraft = true;
        } else if (kind === "edit-submit") {
          await input.press("Enter");
          const request = await gateway.waitForRequest("sessions.goal.update");
          assert(isRecord(request.params));
          assert.equal(request.params.action, "edit");
          assert.equal(request.params.goalId, goal.id);
          assert.equal(request.params.objective, objective);
          const row = await gateway.getSessionRow(scenario.sessionKey);
          assert(row);
          const committed = { ...goal, objective, updatedAt: now + 1 };
          await gateway.setSessionsListResponse({ sessions: [{ ...row, goal: committed }] });
          await gateway.resolveDeferred("sessions.goal.update", {
            status: "updated",
            goalId: goal.id,
            goal: committed,
          });
          await value(page, ordinary, false);
          record.literalEditPayload = request.params;
        } else {
          await input.press("Enter");
          const request = await gateway.waitForRequest("chat.send");
          assert(isRecord(request.params));
          assert.equal(request.params.message, expected);
          if (kind === "start") {
            assert(isRecord(request.params.intent));
            assert.equal(request.params.intent.kind, "session-goal-start");
          } else {
            assert.equal(request.params.intent, undefined);
          }
          await value(page, "", false);
          record.literalChatPayload = request.params;
        }
        cases.push(record);
        await writeFile(
          path.join(out, "receipt.json"),
          JSON.stringify(
            {
              stableVersion,
              stableTagObject,
              stableCommit,
              stableBuildId,
              stableTarballSha256,
              currentCommit,
              currentBuildId,
              stableEntry,
              currentEntry,
              scope:
                "same-origin browser-bundle upgrade with synthetic Gateway transport and real artifact identities; no real Gateway/provider/process upgrade",
              cases,
            },
            null,
            2,
          ),
        );
        console.log("PASS:", kind);
      } catch (error) {
        console.error(
          "RPC methods:",
          (await gateway.getRequests()).map((r) => r.method),
        );
        await page.screenshot({ path: path.join(out, "failure-" + kind + ".png") }).catch(() => {});
        throw error;
      } finally {
        await context.close();
        await server?.close();
      }
    }
  } finally {
    await browser.close();
  }
}
await main();
