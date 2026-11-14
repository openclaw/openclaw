import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";

export async function measureNewSession(
  page: Page,
  output: string,
  run: number,
  options: {
    initialHistory: unknown;
    viewerId: string;
    tokenDelayMs: number;
    worker: boolean;
    filmstrip: boolean;
    held: boolean;
  },
) {
  const cdp = options.filmstrip ? await page.context().newCDPSession(page) : undefined;
  const frames: unknown[] = [];
  if (cdp) {
    cdp.on("Tracing.dataCollected", ({ value }) => frames.push(...value));
    await cdp.send("Tracing.start", {
      categories: "blink.user_timing,disabled-by-default-devtools.screenshot",
      transferMode: "ReportEvents",
    });
  }
  try {
    await page.evaluate(
      ({ held, viewerId, tokenDelayMs, worker }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        gateway.setMethodResponse("chat.history", { messages: [] });
        gateway.setMethodResponse("chat.startup", { messages: [] });
        const state = {
          held,
          marks: {} as Record<string, number>,
          states: [] as unknown[],
          key: "",
          done: false,
          start: performance.now(),
        };
        Reflect.set(window, "__l247", state);
        let oldState = "";
        const monitor = () => {
          const at = performance.now();
          const draft = document.querySelector<HTMLTextAreaElement>(".new-session-page__message");
          const user = [...document.querySelectorAll(".chat-group.user")].find((el) =>
            el.textContent?.includes("L247 synthetic first message"),
          );
          const token = [...document.querySelectorAll(".chat-group.assistant")].find((el) =>
            el.textContent?.includes("L247 first token"),
          );
          const createRow = document.querySelector(".sidebar-recent-session--creating");
          const row =
            (state.key &&
              [...document.querySelectorAll("[data-session-key]")].find(
                (el) => el.getAttribute("data-session-key") === state.key,
              )) ||
            createRow?.querySelector('.sidebar-recent-session__link:not([aria-busy="true"])');
          const status =
            document.querySelector(".chat-working-indicator")?.textContent ??
            document.querySelector(".chat-group--working")?.textContent;
          const values = {
            draft: Boolean(draft?.checkVisibility()),
            interactive: Boolean(draft?.checkVisibility() && !draft.disabled),
            user: Boolean(user?.checkVisibility()),
            token: Boolean(token?.checkVisibility()),
            createRow: Boolean(createRow),
            row: Boolean(row),
            status,
          };
          for (const [name, value] of Object.entries(values)) {
            if (value && !state.marks[name]) {
              state.marks[name] = at;
            }
          }
          const signature = JSON.stringify(values);
          if (signature !== oldState) {
            state.states.push({ at, ...values });
          }
          oldState = signature;
          if (values.token) {
            state.done = true;
            performance.mark("l247:token");
          }
          if (!state.done) {
            requestAnimationFrame(monitor);
          }
        };
        requestAnimationFrame(monitor);
        document.addEventListener(
          "click",
          (event) => {
            const el = event.target instanceof Element ? event.target.closest("a,button") : null;
            if (el?.matches('a[href*="/new"]')) {
              state.marks.click = performance.now();
              performance.mark("l247:click");
            }
            if (el?.matches(".new-session-page__start-submit")) {
              state.marks.send = performance.now();
            }
          },
          true,
        );
        if (held) {
          gateway.setRequestHandler("sessions.list", () => {});
        }
        gateway.setRequestHandler("sessions.create", ({ params, respond, emit }) => {
          state.key =
            params &&
            typeof params === "object" &&
            "key" in params &&
            typeof params.key === "string"
              ? params.key
              : "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
          state.marks.createHandler = performance.now();
          const entry = {
            sessionId: "l247-session",
            kind: "direct",
            updatedAt: Date.now(),
            agentId: "main",
            owner: { actor: { id: viewerId, identity: { type: "profile", id: viewerId } } },
            key: state.key,
            displayName: "L247 synthetic session",
            ...(worker
              ? { placement: { state: "active", generation: 1, environmentId: "l247-worker" } }
              : {}),
          };
          Reflect.get(window, "__teamScaleSidebarLists").apply({ upsert: [entry] });
          const history = {
            sessionId: entry.sessionId,
            sessionInfo: entry,
            messages: [],
            ...(!worker
              ? { inFlightRun: { runId: "l247-run", startedAt: Date.now(), text: "", events: [] } }
              : {}),
          };
          gateway.setMethodResponse("chat.history", history);
          gateway.setMethodResponse("chat.startup", history);
          respond({
            key: state.key,
            entry,
            runStarted: !worker,
            ...(!worker ? { runId: "l247-run" } : {}),
          });
          if (worker) {
            return;
          }
          setTimeout(() => {
            state.marks.deltaEmitted = performance.now();
            emit("chat", {
              sessionKey: state.key,
              runId: "l247-run",
              seq: 1,
              state: "delta",
              message: { role: "assistant", content: [{ type: "text", text: "L247 first token" }] },
            });
          }, 55 + tokenDelayMs);
        });
        if (worker) {
          gateway.setRequestHandler("chat.send", ({ params, respond, emit }) => {
            if (
              !params ||
              typeof params !== "object" ||
              !("idempotencyKey" in params) ||
              typeof params.idempotencyKey !== "string"
            ) {
              throw new Error("Missing first-turn idempotency key");
            }
            const runId = params.idempotencyKey;
            state.marks.sendHandler = performance.now();
            respond({ runId, status: "started" });
            emit("chat", {
              sessionKey: state.key,
              runId,
              seq: 1,
              state: "status",
              phase: "preparing_context",
            });
            setTimeout(() => {
              state.marks.deltaEmitted = performance.now();
              emit("chat", {
                sessionKey: state.key,
                runId,
                seq: 2,
                state: "delta",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "L247 first token" }],
                },
              });
            }, tokenDelayMs);
          });
        }
      },
      {
        held: options.held,
        viewerId: options.viewerId,
        tokenDelayMs: options.tokenDelayMs,
        worker: options.worker,
      },
    );
    await page.locator('a[href*="/new?"]:visible').first().click();
    const draft = page.locator(".new-session-page__message");
    await draft.fill("L247 synthetic first message");
    await page.evaluate(() => {
      Reflect.get(window, "__l247").marks.typed = performance.now();
    });
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, "__l247").marks.user);
    if (run <= 2) {
      await page.screenshot({ path: path.join(output, `l247-${run}-pending.png`) });
    }
    try {
      await page.waitForFunction(() => Reflect.get(window, "__l247").done, undefined, {
        timeout: 20000,
      });
    } catch (error) {
      console.log(
        JSON.stringify(
          await page.evaluate(() => ({
            ...Reflect.get(window, "__l247"),
            census: Reflect.get(window, "__coldLoad").read(),
          })),
        ),
      );
      throw error;
    }
    await page.evaluate((original) => {
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.setMethodResponse(
        "chat.startup",
        original,
      );
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.setMethodResponse(
        "chat.history",
        original,
      );
    }, options.initialHistory);
    const result = await page.evaluate(() => ({
      ...Reflect.get(window, "__l247"),
      census: Reflect.get(window, "__coldLoad").read(),
    }));
    if (run <= 2) {
      await page.screenshot({ path: path.join(output, `l247-${run}-token.png`) });
    }
    return result;
  } finally {
    if (cdp) {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
      await writeFile(path.join(output, `l247-${run}.filmstrip.json`), JSON.stringify(frames));
      await cdp.detach();
    }
  }
}
