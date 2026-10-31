import { describe, expect, it } from "vitest";
import { callTargetTool, resolveChromeMcpSnapshotRef } from "./chrome-mcp-routing.js";
import * as fixture from "./chrome-mcp.chromium.test-support.js";
import {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  selectChromeMcpOption,
  takeChromeMcpSnapshot,
} from "./chrome-mcp.js";
import {
  flattenChromeMcpSnapshotToAriaResult,
  type ChromeMcpSnapshotNode,
} from "./chrome-mcp.snapshot.js";
import { getFreePort } from "./test-port.js";

async function act(routes: ReturnType<typeof fixture.mcpRoutes>, body: Record<string, unknown>) {
  const response = await fixture.routePost(routes, "/act", body);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
}

function snapshotRef(root: ChromeMcpSnapshotNode, role: string, name: string): string {
  const node = flattenChromeMcpSnapshotToAriaResult(root).nodes.find(
    (candidate) => candidate.role === role && candidate.name === name,
  );
  if (!node?.ref) {
    throw new Error(`Snapshot has no ${role} named "${name}"`);
  }
  return node.ref;
}

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")(
  "pinned Chrome MCP in Chromium",
  () => {
    it("preserves native input, option values, and operation outcomes", async () => {
      await fixture.withMcpBrowser(async ({ page, profile, profileName }) => {
        await page.setContent(`<!doctype html>
        <input id="focus" style="position:absolute;left:10px;top:10px;width:100px;height:30px">
        <iframe style="position:absolute;left:200px;top:10px;width:100px;height:80px;border:0"
          srcdoc="<button style='width:80px;height:50px' onclick='parent.document.body.dataset.frame = event.isTrusted'>Frame</button>"></iframe>
        <div id="shadow" style="position:absolute;left:400px;top:10px"></div>
        <select aria-label="Country" style="position:absolute;left:10px;top:120px">
          <option value="CA">Region</option><option value="US">Region</option>
          <option value="">Empty</option><option value="  spaced  ">Spaced</option>
        </select>
        <script>
          document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML =
            '<button style="width:80px;height:50px">Shadow</button>';
          document.querySelector('#shadow').shadowRoot.querySelector('button').onclick =
            (event) => { document.body.dataset.shadow = event.isTrusted; };
          document.querySelector('select').addEventListener('change', () => {
            document.body.dataset.selected = document.querySelector('select').value;
          });
        </script>`);
        const tabs = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = { profileName, profile, targetId: tabs[0]!.targetId, timeoutMs: 10_000 };
        await clickChromeMcpCoords({ ...target, x: 30, y: 25 });
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus");
        await clickChromeMcpCoords({ ...target, x: 230, y: 35 });
        await clickChromeMcpCoords({ ...target, x: 430, y: 35 });
        expect(
          await page.evaluate(() => ({
            frame: document.body.dataset.frame,
            shadow: document.body.dataset.shadow,
          })),
        ).toMatchObject({
          frame: "true",
          shadow: "true",
        });
        const root = await takeChromeMcpSnapshot(target);
        const uid = snapshotRef(root, "combobox", "Country");
        for (const value of ["US", "", "  spaced  "]) {
          await selectChromeMcpOption({ ...target, uid, value });
          expect(await page.locator("select").inputValue()).toBe(value);
          expect(await page.evaluate(() => document.body.dataset.selected)).toBe(value);
        }
        await expect(
          evaluateChromeMcpScript({
            ...target,
            fn: "() => { document.body.dataset.evaluations = String(Number(document.body.dataset.evaluations ?? 0) + 1); }",
          }),
        ).resolves.toBeUndefined();
        expect(await page.evaluate(() => document.body.dataset.evaluations)).toBe("1");

        const unreachableUrl = `http://127.0.0.1:${await getFreePort()}/unreachable`;
        await expect(navigateChromeMcpPage({ ...target, url: unreachableUrl })).rejects.toThrow(
          "ERR_CONNECTION_REFUSED",
        );
        await expect(
          openChromeMcpTab(profileName, unreachableUrl, profile, {
            timeoutMs: 10_000,
            cdpPolicy: { dangerouslyAllowPrivateNetwork: true },
          }),
        ).rejects.toThrow("ERR_CONNECTION_REFUSED");
        expect(await listChromeMcpTabs(profileName, profile)).toHaveLength(1);
      });
    }, 120_000);

    it("preserves controls through polling and recaptures after cross-origin navigation", async () => {
      await fixture.withMcpBrowser(
        async ({ page, context: browserContext, profile, profileName }) => {
          const fixturePort = await getFreePort();
          const originalUrl = `http://127.0.0.1:${fixturePort}/original`;
          const replacementUrl = `http://localhost:${fixturePort}/replacement`;
          for (const { url, phase } of [
            { url: originalUrl, phase: "original" },
            { url: replacementUrl, phase: "replacement" },
          ]) {
            await fixture.serveHtml(
              browserContext,
              url,
              `<!doctype html><body data-phase="${phase}">${fixture.controls(
                32,
                (index) =>
                  `<button onclick="document.body.dataset.clicked = '${phase}'">${index === 0 ? "Run" : `${phase} ${index}`}</button>`,
              )}</body>`,
            );
          }
          await page.goto(originalUrl);
          const routes = fixture.mcpRoutes(profileName, profile, true);
          const snapshot = await fixture.routeSnapshot(routes);
          const target = { profileName, profile, targetId: snapshot.targetId };
          const ref = Object.entries(snapshot.refs).find(([, value]) => value.name === "Run")?.[0];
          expect(ref).toBeTypeOf("string");
          await act(routes, {
            kind: "wait",
            targetId: snapshot.targetId,
            timeoutMs: 10_000,
            fn: `() => {
            const polls = Number(document.body.dataset.polls ?? 0) + 1;
            document.body.dataset.polls = String(polls);
            return polls >= 2;
          }`,
          });
          await act(routes, { kind: "click", targetId: snapshot.targetId, ref });
          expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("original");
          expect(
            Number(await page.evaluate(() => document.body.dataset.polls)),
          ).toBeGreaterThanOrEqual(2);

          await page.goto(replacementUrl);
          await expect(
            evaluateChromeMcpScript({
              ...target,
              timeoutMs: 10_000,
              args: [ref!],
              fn: `(element) => {
              element.ownerDocument.body.dataset.staleRefExecuted = "true";
              return element.textContent;
            }`,
            }),
          ).rejects.toThrow(/Element (?:with )?uid .* (?:not found|no longer exists)/);
          expect(await page.evaluate(() => document.body.dataset.staleRefExecuted)).toBeUndefined();

          await act(routes, {
            kind: "wait",
            targetId: snapshot.targetId,
            timeoutMs: 10_000,
            fn: '() => document.body.dataset.phase === "replacement"',
          });
          await expect(
            evaluateChromeMcpScript({
              ...target,
              args: [ref!],
              fn: "(element) => element.textContent",
            }),
          ).rejects.toThrow(/Unknown ref/);

          const replacementSnapshot = await fixture.routeSnapshot(routes, snapshot.targetId);
          expect(replacementSnapshot.targetId).toBe(snapshot.targetId);
          const replacementRef = Object.entries(replacementSnapshot.refs).find(
            ([, value]) => value.name === "Run",
          )?.[0];
          expect(replacementRef).toBeTypeOf("string");
          expect(replacementRef).not.toBe(ref);
          await act(routes, { kind: "click", targetId: snapshot.targetId, ref: replacementRef });
          expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("replacement");
        },
      );
    }, 120_000);

    it("keeps CSS lookup bound to the captured renderer and document", async () => {
      await fixture.withMcpBrowser(async ({ page, context, profile, profileName }) => {
        const fixturePort = await getFreePort();
        const mainUrl = `http://127.0.0.1:${fixturePort}/styles`;
        const frameUrl = `http://localhost:${fixturePort}/frame`;
        const replacementUrl = `http://localhost:${fixturePort}/replacement`;
        await fixture.serveHtml(
          context,
          mainUrl,
          `<!doctype html><style>.top { color: red; }</style>${fixture.controls(
            64,
            (index) => `<button class="top">Top ${index}</button>`,
          )}<iframe src="${frameUrl}"></iframe>`,
        );
        await fixture.serveHtml(
          context,
          frameUrl,
          `<!doctype html><style>.frame { color: blue; }</style>${fixture.controls(
            32,
            (index) => `<button class="frame">Frame ${index}</button>`,
          )}`,
        );
        await fixture.serveHtml(
          context,
          replacementUrl,
          '<!doctype html><button class="replacement">Replacement</button>',
        );
        await page.goto(mainUrl);

        const [tab] = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = {
          profileName,
          profile,
          targetId: tab!.targetId,
          timeoutMs: 10_000,
        };
        const snapshot = await takeChromeMcpSnapshot(target);
        const topRef = snapshotRef(snapshot, "button", "Top 0");
        const frameRef = snapshotRef(snapshot, "button", "Frame 0");
        const styles = (ref: string) =>
          callTargetTool(target, "get_css_styles", (session) => ({
            uid: resolveChromeMcpSnapshotRef(session, target.targetId, ref).uid,
            pageSize: 10,
            pageIdx: 0,
          }));

        await expect(styles(topRef)).resolves.toBeDefined();
        await expect(styles(frameRef)).rejects.toThrow(/detached or no longer exists/);

        await page.goto(replacementUrl);
        await expect(styles(topRef)).rejects.toThrow(/no longer exists/);
      });
    }, 120_000);

    it("retires canceled session handles and reconnects to the same browser", async () => {
      await fixture.withMcpBrowser(async ({ page, profile, profileName }) => {
        await page.setContent(
          "<button onclick=\"document.body.dataset.clicked = 'true'\">Run</button>",
        );
        const [tab] = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = { profileName, profile, targetId: tab!.targetId, timeoutMs: 10_000 };
        const oldRef = snapshotRef(await takeChromeMcpSnapshot(target), "button", "Run");
        const controller = new AbortController();
        const cancellation = new Error("Canceled browser evaluation");
        const evaluation = evaluateChromeMcpScript({
          ...target,
          signal: controller.signal,
          fn: `() => {
            document.body.dataset.evaluationStarted = "true";
            return new Promise(() => {});
          }`,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          const started = await page.waitForFunction(
            () => document.body.dataset.evaluationStarted === "true",
            undefined,
            { timeout: 10_000 },
          );
          await started.dispose();
          controller.abort(cancellation);
          expect(await evaluation).toEqual({ error: cancellation });

          const tabs = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
          expect(tabs).toHaveLength(1);
          const reconnected = { ...target, targetId: tabs[0]!.targetId };
          expect(reconnected.targetId).not.toBe(target.targetId);
          await expect(takeChromeMcpSnapshot(target)).rejects.toThrow(/tab not found/);
          await expect(clickChromeMcpElement({ ...reconnected, uid: oldRef })).rejects.toThrow(
            /Unknown ref/,
          );
          const freshRef = snapshotRef(await takeChromeMcpSnapshot(reconnected), "button", "Run");
          await clickChromeMcpElement({ ...reconnected, uid: freshRef });
          expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("true");
        } finally {
          controller.abort(cancellation);
          await evaluation;
        }
      });
    }, 120_000);
  },
);
