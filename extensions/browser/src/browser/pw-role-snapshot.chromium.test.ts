import type { BrowserContext, CDPSession } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import type { CdpProtocolSend } from "./cdp-ax.js";
import { snapshotRoleViaCdpSession } from "./cdp-role-snapshot.js";
import { snapshotRoleViaCdp } from "./cdp.js";
import { withChromiumPage } from "./pw-chromium.test-support.js";
import {
  getDocumentIdentitiesViaPlaywright,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import {
  snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright,
  storeSnapshotRefsViaPlaywright,
} from "./pw-tools-core.snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const controlsHtml =
  "<style>button{min-width:30px;min-height:25px}</style><main></main><output></output>";

function withSnapshotPage(html: string, run: Parameters<typeof withChromiumPage>[2]) {
  return withChromiumPage(tempDirs.make("openclaw-role-snapshot-"), html, run);
}

function appendControls(controls: { id: string; name: string; native?: boolean }[]) {
  for (const { id, name, native } of controls) {
    const button = document.createElement("button");
    if (!native) {
      button.setAttribute("aria-label", name);
    }
    button.textContent = native ? name : name ? "control" : "";
    button.addEventListener("click", () => {
      document.querySelector("output")!.textContent = id;
    });
    document.querySelector("main")!.append(button);
  }
}

async function withCdpSend(
  context: BrowserContext,
  intercept: (send: CdpProtocolSend) => CdpProtocolSend,
  run: () => Promise<void>,
) {
  const newSession = context.newCDPSession.bind(context);
  const spy = vi.spyOn(context, "newCDPSession").mockImplementation(async (page) => {
    const session = await newSession(page);
    const send = session.send.bind(session);
    vi.spyOn(session, "send").mockImplementation(intercept(send) as CDPSession["send"]);
    return session;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Chromium snapshot-to-action name fidelity",
  () => {
    it.each(["injection", "lookup"] as const)(
      "clears cursor discovery markers after a failed %s reply",
      async (phase) => {
        await withSnapshotPage(
          '<div style="cursor:pointer" onclick="void 0">Cursor control</div>',
          async ({ page }) => {
            const session = await page.context().newCDPSession(page);
            const nativeSend = session.send.bind(session);
            let failed = false;
            const send: CdpProtocolSend = async (method, params) => {
              if (!failed && phase === "lookup" && method === "DOM.getDocument") {
                expect(await page.locator("[data-openclaw-cdp-ci]").count()).toBe(1);
                failed = true;
                throw new Error("Synthetic DOM lookup failure");
              }
              const result = await nativeSend(method, params);
              if (!failed && phase === "injection" && method === "Runtime.evaluate") {
                expect(await page.locator("[data-openclaw-cdp-ci]").count()).toBe(1);
                failed = true;
                throw new Error("Synthetic lost injection reply");
              }
              return result;
            };
            try {
              await snapshotRoleViaCdpSession({ send });
              expect(failed).toBe(true);
              expect(await page.locator("[data-openclaw-cdp-ci]").count()).toBe(0);
            } finally {
              await session.detach();
            }
          },
        );
      },
    );

    it.each(["Accessibility.getFullAXTree", "DOM.getDocument"])(
      "rejects raw ARIA refs when navigation replaces the document during %s",
      async (interruptedMethod) => {
        await withSnapshotPage("<button>Save</button>", async ({ page, target }) => {
          const capturedPage = await getPageForTargetId(target);
          const replacement = "data:text/html,<button>Save replacement</button>";
          let interrupted = false;
          await withCdpSend(
            capturedPage.context(),
            (send) => async (method, params) => {
              const result = await send(method, params);
              if (method === interruptedMethod && !interrupted) {
                interrupted = true;
                await page.goto(replacement);
                await expect.poll(() => capturedPage.url()).toBe(replacement);
              }
              return result;
            },
            async () => {
              await expect(snapshotAriaViaPlaywright(target)).rejects.toThrow("Frame changed");
              expect(interrupted).toBe(true);
              expect(() => refLocator(capturedPage, "ax1")).toThrow("Unknown ref");
            },
          );
        });
      },
      30_000,
    );

    it("returns selector no-match snapshots without waiting for the snapshot timeout", async () => {
      await withSnapshotPage(
        '<main><button id="present">Present</button><a href="https://example.test/docs">Docs</a></main>',
        async ({ target }) => {
          const request = { ...target, timeoutMs: 30_000 };
          const startedAt = performance.now();
          const missing = await snapshotRoleViaPlaywright({
            ...request,
            selector: "#missing",
            urls: true,
          });
          const elapsedMs = performance.now() - startedAt;
          const present = await snapshotRoleViaPlaywright({ ...request, selector: "#present" });
          const refFree = await snapshotRoleViaPlaywright({
            ...request,
            selector: "main",
            options: { maxDepth: 0 },
            urls: true,
          });
          expect(missing.snapshot).toBe("(empty)");
          expect(missing.snapshot).not.toContain("https://example.test/docs");
          expect(missing.refs).toEqual({});
          expect(elapsedMs).toBeLessThan(1_000);
          expect(present.snapshot).toContain('button "Present"');
          expect(refFree.refs).toEqual({});
          expect(refFree.snapshot).toContain("https://example.test/docs");
        },
      );
    }, 30_000);

    it("does not retarget CDP refs after marker writes fail", async () => {
      await withSnapshotPage(
        [
          "<button onclick=\"document.querySelector('output').textContent='first'\">Native</button>",
          "<button onclick=\"document.querySelector('output').textContent='second'\">Native</button>",
          "<div style=\"cursor:pointer\" onclick=\"document.querySelector('output').textContent='cursor'\">Cursor card</div>",
          "<output></output>",
          '<iframe srcdoc="<button>Child frame</button>"></iframe>',
        ].join(""),
        async ({ page, context, target }) => {
          await page.frameLocator("iframe").getByRole("button").waitFor();
          const { cdpUrl, targetId } = target;
          const targets = (await fetch(`${cdpUrl}/json/list`).then((res) => res.json())) as Array<{
            id?: string;
            webSocketDebuggerUrl?: string;
          }>;
          const wsUrl = targets.find((entry) => entry.id === targetId)?.webSocketDebuggerUrl;
          expect(wsUrl).toBeTypeOf("string");
          const snapshot = await snapshotRoleViaCdp({
            wsUrl: wsUrl!,
            options: { interactive: true },
            recurseIframes: false,
          });
          const nativeRefs = Object.entries(snapshot.refs).filter(
            ([, info]) => info.name === "Native",
          );
          const cursorRef = Object.entries(snapshot.refs).find(
            ([, info]) => info.name === "Cursor card",
          )?.[0];

          expect(nativeRefs).toHaveLength(2);
          expect(cursorRef).toBeDefined();
          expect(Object.values(snapshot.refs).some((info) => info.name === "Child frame")).toBe(
            false,
          );
          const { mainFrame: expectedDocumentIdentity } =
            await getDocumentIdentitiesViaPlaywright(target);
          const nativeRefSet = new Set(nativeRefs.map(([ref]) => ref));
          await withCdpSend(
            context,
            (send) => async (method, params) => {
              const value = params && "value" in params ? params.value : undefined;
              if (
                method === "DOM.setAttributeValue" &&
                typeof value === "string" &&
                nativeRefSet.has(value)
              ) {
                throw new Error("marker write blocked");
              }
              return await send(method, params);
            },
            () =>
              storeSnapshotRefsViaPlaywright({
                ...target,
                page,
                refs: snapshot.refs,
                expectedDocumentIdentity,
              }),
          );

          for (const [ref] of nativeRefs) {
            expect(await page.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${ref}"]`).count()).toBe(
              0,
            );
          }
          for (const [ref] of nativeRefs) {
            await expect(clickViaPlaywright({ ...target, ref, timeoutMs: 500 })).rejects.toThrow();
            expect(await page.locator("output").textContent()).toBe("");
          }
          await clickViaPlaywright({ ...target, ref: cursorRef!, timeoutMs: 1_000 });
          expect(await page.locator("output").textContent()).toBe("cursor");
        },
      );
    }, 30_000);

    it("resolves encoded and omitted names, raw AX names, and native frame refs", async () => {
      await withSnapshotPage(
        `${controlsHtml}<iframe title="Nested"></iframe>`,
        async ({ page, target }) => {
          const buttonName = 'Save: "owner\'s" C:\\draft 🦞';
          const inputName = 'Project "path"';
          const nameControls = [
            { id: "short", name: "Named control" },
            { id: "empty", name: "" },
            { id: "empty-again", name: "" },
            { id: "name-900", name: "x".repeat(900) },
            { id: "name-901", name: "x".repeat(901) },
            { id: "surrogates-900", name: "😀".repeat(450) },
            { id: "surrogates-901", name: "😀".repeat(450) + "x" },
            { id: "normalized-empty", name: "\u200b\u00ad" },
            { id: "normalized-899", name: "  x \n".repeat(450) },
            { id: "normalized-901", name: "  x \n".repeat(451) },
          ];
          await page.evaluate(
            ({ inputName: label }) => {
              const input = document.createElement("input");
              input.setAttribute("aria-label", label);
              document.querySelector("main")!.append(input);
              document.querySelector("iframe")!.srcdoc =
                "<button onclick=\"this.textContent='Frame clicked'\">Frame: action</button>";
            },
            { inputName },
          );
          await page.evaluate(appendControls, [
            ...["first", "second"].map((id) => ({ id, name: buttonName, native: true })),
            { id: "/", name: "/", native: true },
            ...nameControls,
          ]);
          await page.frameLocator("iframe").getByRole("button").waitFor();
          for (const mode of ["role", "interactive", "ai", "interactive-aria"] as const) {
            const snapshot = await snapshotRoleViaPlaywright({
              ...target,
              refsMode: mode === "ai" || mode === "interactive-aria" ? "aria" : "role",
              options: mode === "ai" ? undefined : { interactive: mode !== "role" },
            });
            const buttons = Object.entries(snapshot.refs).filter(
              ([, value]) => value.role === "button" && value.name !== "Frame: action",
            );
            const expectedButtons = ["first", "second", "/", ...nameControls.map(({ id }) => id)];
            expect(buttons, mode).toHaveLength(expectedButtons.length);
            for (const [index, [ref]] of buttons.entries()) {
              await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
              expect(await page.locator("output").textContent(), mode).toBe(expectedButtons[index]);
            }
            const input = Object.entries(snapshot.refs).find(
              ([, value]) => value.role === "textbox" && value.name === inputName,
            );
            expect(input, mode).toBeDefined();
            await typeViaPlaywright({ ...target, ref: input![0], text: mode, timeoutMs: 1_000 });
            expect(await page.getByRole("textbox").inputValue()).toBe(mode);
          }
          const snapshot = await snapshotRoleViaPlaywright({ ...target, refsMode: "aria" });
          const nested = Object.entries(snapshot.refs).find(
            ([, value]) => value.name === "Frame: action",
          );
          expect(nested).toBeDefined();
          await clickViaPlaywright({ ...target, ref: nested![0], timeoutMs: 1_000 });
          expect(await page.frameLocator("iframe").getByRole("button").textContent()).toBe(
            "Frame clicked",
          );

          await page.setContent(controlsHtml);
          const rawControls = [
            { id: "raw-short", name: "Raw named control" },
            { id: "raw-empty", name: "" },
            { id: "raw-long", name: "x".repeat(901) },
            { id: "raw-short-again", name: "Raw named control" },
          ];
          await page.evaluate(appendControls, rawControls);
          const aria = await snapshotAriaViaPlaywright(target);
          const rawButtons = aria.nodes.filter((node) => node.role.toLowerCase() === "button");
          expect(rawButtons).toHaveLength(rawControls.length);
          expect(
            await page
              .getByRole("button", { name: "", exact: true })
              .getAttribute(BROWSER_REF_MARKER_ATTRIBUTE),
          ).toBe(rawButtons[1]!.ref);
          await clickViaPlaywright({ ...target, ref: rawButtons[1]!.ref, timeoutMs: 1_000 });
          expect(await page.locator("output").textContent()).toBe("raw-empty");
          // Real AX names with unavailable DOM ids exercise the existing role fallback.
          // Restore onto the launcher's distinct Page wrapper to cross the target cache.
          await storeSnapshotRefsViaPlaywright({
            ...target,
            nodes: aria.nodes.map(({ backendDOMNodeId: _backendId, ...node }) => node),
          });
          expect(await page.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`).count()).toBe(0);
          restoreRoleRefsForTarget({ ...target, page });
          for (const [index, node] of rawButtons.entries()) {
            await refLocator(page, node.ref).click({ timeout: 1_000 });
            expect(await page.locator("output").textContent()).toBe(rawControls[index]!.id);
          }
        },
      );
    }, 30_000);
  },
);
