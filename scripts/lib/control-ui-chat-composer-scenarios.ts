import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, prepareChat } from "./control-ui-interaction-navigation.ts";

const pane = ".chat-pane-cache__pane--active";
const composer = `${pane} .agent-chat__composer-combobox textarea`;
const route = controlUiSessionPath("agent:main:interaction-a");

/** Observe native events in-page: Playwright assertion latency is not input latency. */
export async function installChatActionObservation(
  page: Page,
  collectAttribution = false,
  followPaneChanges = false,
) {
  await page.evaluate(
    ({ attribution, trackPaneChanges }) => {
      const data = {
        inputFramesMs: [] as number[],
        longTasksMs: [] as number[],
        layoutShift: 0,
        recentInputLayoutShift: 0,
        insertedRows: 0,
        removedRows: 0,
        layoutShiftSources: [] as unknown[],
      };
      const initialPane = document.querySelector(".chat-pane-cache__pane--active");
      const transcript = initialPane?.querySelector(".chat-thread");
      const observationRoot = trackPaneChanges
        ? initialPane?.closest(".chat-split-view")
        : transcript;
      if (!transcript || !observationRoot || !initialPane) {
        throw new Error("Chat action observation requires the prepared transcript");
      }
      const initialRows = new Map(
        [...initialPane.querySelectorAll("[data-chat-row-key]")].map((row) => [
          row.getAttribute("data-chat-row-key"),
          row,
        ]),
      );
      const recordInput = () => {
        const start = performance.now();
        requestAnimationFrame(() => data.inputFramesMs.push(performance.now() - start));
      };
      const events = ["input", "keydown", "pointerdown", "pointerover", "paste", "drop"];
      events.forEach((event) => document.addEventListener(event, recordInput, true));
      const supported = PerformanceObserver.supportedEntryTypes;
      const observers: PerformanceObserver[] = [];
      if (supported.includes("longtask")) {
        const observer = new PerformanceObserver((list) => {
          data.longTasksMs.push(...list.getEntries().map((entry) => entry.duration));
        });
        observer.observe({ type: "longtask" });
        observers.push(observer);
      }
      if (supported.includes("layout-shift")) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const value: unknown = Reflect.get(entry, "value");
            if (typeof value !== "number") {
              throw new Error("Layout shift entry missing value");
            }
            if (Reflect.get(entry, "hadRecentInput")) {
              data.recentInputLayoutShift += value;
            } else {
              data.layoutShift += value;
            }
            if (attribution) {
              // SAFETY: The LayoutShift API supplies source nodes and both rectangles.
              const sources = Reflect.get(entry, "sources") as Array<{
                node?: Node;
                previousRect: DOMRectReadOnly;
                currentRect: DOMRectReadOnly;
              }>;
              data.layoutShiftSources.push({
                time: entry.startTime,
                value,
                hadRecentInput: Reflect.get(entry, "hadRecentInput"),
                sources: sources.map(({ node, previousRect, currentRect }) => ({
                  tag: node instanceof Element ? node.tagName : node?.nodeName,
                  classes: node instanceof Element ? node.getAttribute("class") : null,
                  row:
                    node instanceof Element
                      ? node.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key")
                      : null,
                  previous: {
                    x: previousRect.x,
                    y: previousRect.y,
                    width: previousRect.width,
                    height: previousRect.height,
                  },
                  current: {
                    x: currentRect.x,
                    y: currentRect.y,
                    width: currentRect.width,
                    height: currentRect.height,
                  },
                })),
              });
            }
          }
        });
        observer.observe({ type: "layout-shift" });
        observers.push(observer);
      }
      const rows = (nodes: NodeList) =>
        [...nodes].reduce(
          (count, node) =>
            count +
            (node instanceof Element
              ? Number(node.matches("[data-chat-row-key]")) +
                node.querySelectorAll("[data-chat-row-key]").length
              : 0),
          0,
        );
      const mutations = new MutationObserver((records) => {
        for (const record of records) {
          data.insertedRows += rows(record.addedNodes);
          data.removedRows += rows(record.removedNodes);
        }
      });
      // Fork and split mount their destinations in other panes or cells.
      mutations.observe(observationRoot, {
        childList: true,
        subtree: true,
      });
      Reflect.set(window, "__chatActionObservation", {
        data,
        initialPane,
        initialRows,
        stop: () => {
          events.forEach((event) => document.removeEventListener(event, recordInput, true));
          observers.forEach((observer) => observer.disconnect());
          mutations.disconnect();
        },
      });
    },
    { attribution: collectAttribution, trackPaneChanges: followPaneChanges },
  );
}

export async function readChatActionObservation(page: Page) {
  await frames(page);
  const observed = await page.evaluate(() => {
    const observation = Reflect.get(window, "__chatActionObservation");
    observation.stop();
    const data = observation.data;
    const currentPane = document.querySelector(".chat-pane-cache__pane--active");
    const currentRows = [...(currentPane?.querySelectorAll("[data-chat-row-key]") ?? [])];
    const survivingRows =
      currentPane === observation.initialPane
        ? currentRows.filter((row) =>
            observation.initialRows.has(row.getAttribute("data-chat-row-key")),
          )
        : [];
    const times: number[] = data.inputFramesMs.toSorted((a: number, b: number) => a - b);
    const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
    const layoutShiftSupported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    return {
      nativeInputs: times.length,
      ...(times.length
        ? {
            inputFrameP95Ms: times[Math.ceil(times.length * 0.95) - 1]!,
            inputFrameMaxMs: times.at(-1)!,
          }
        : {}),
      longTasksSupported,
      ...(longTasksSupported
        ? {
            longTaskCount: data.longTasksMs.length,
            longestLongTaskMs: Math.max(0, ...data.longTasksMs),
          }
        : {}),
      layoutShiftSupported,
      ...(layoutShiftSupported
        ? {
            layoutShift: data.layoutShift,
            recentInputLayoutShift: data.recentInputLayoutShift,
            ...(data.layoutShiftSources.length
              ? { layoutShiftSources: data.layoutShiftSources }
              : {}),
          }
        : {}),
      insertedRows: data.insertedRows,
      removedRows: data.removedRows,
      connectedRows: currentRows.length,
      survivingRows: survivingRows.length,
      replacedRows: survivingRows.filter(
        (row) => observation.initialRows.get(row.getAttribute("data-chat-row-key")) !== row,
      ).length,
    };
  });
  return observed;
}

export function createChatComposerScenarios(): readonly EngineScenario[] {
  const base = { route, explicitOnly: true, prepare: prepareChat };
  const people = Array.from({ length: 50 }, (_, index) => ({
    profileId: `00000003-1111-4111-8111-${String(index).padStart(12, "0")}`,
    displayName: `Casey ${String(index).padStart(2, "0")}`,
    online: true,
  }));
  return [
    {
      ...base,
      id: "chat-actions-slash",
      expected:
        "Open, filter, navigate, and complete 200 plugin commands in a 400-message session.",
      fixtureOverrides: () => ({
        methodResponses: {
          "commands.list": {
            commands: Array.from({ length: 200 }, (_, index) => ({
              name: `review-${String(index).padStart(3, "0")}`,
              description: `Review synthetic deployment ${index} and summarize its validation report.`,
              category: "tools",
              acceptsArgs: true,
              scope: "both",
              source: "plugin",
              textAliases: [`/review-${String(index).padStart(3, "0")}`],
            })),
          },
        },
      }),
      run: async (page) => {
        const input = page.locator(composer);
        let renderedOptions = 0;
        let menuSvgNodes = 0;
        let menuContentWrappers = 0;
        for (let cycle = 0; cycle < 4; cycle++) {
          await input.pressSequentially("/");
          const menu = page.locator(`${pane} .slash-menu`);
          await menu.waitFor({ state: "visible" });
          await menu
            .locator('[id$="-slash-option-command-review-199"]')
            .waitFor({ state: "visible" });
          if (cycle === 0) {
            renderedOptions = await menu.locator(".slash-menu-item").count();
            menuSvgNodes = await menu.locator(".slash-menu-icon svg").count();
            menuContentWrappers = await menu
              .locator(".slash-menu-icon .chat-composer-lit-content")
              .count();
          }
          await input.press("ArrowDown");
          await input.press("ArrowUp");
          await input.pressSequentially("comp");
          await menu.locator('[id$="-slash-option-command-compact"]').waitFor({ state: "visible" });
          await input.press("Tab");
          if (!(await input.inputValue()).startsWith("/compact")) {
            throw new Error("Slash completion lost the filtered command");
          }
          await input.press("ControlOrMeta+a");
          await input.press("Backspace");
        }
        return {
          cycles: 4,
          pluginCommands: 200,
          renderedOptions,
          menuSvgNodes,
          menuContentWrappers,
        };
      },
    },
    {
      ...base,
      id: "chat-actions-mention",
      expected: "Open and filter 50 people, navigate, and insert the selected mention.",
      fixtureOverrides: () => ({
        presenceUsers: [
          { self: true, id: "viewer", name: "Viewer", identity: { type: "profile", id: "viewer" } },
        ],
      }),
      createRequestHandlers: () => ({
        "users.mentionable": (params) => {
          if (!isRecord(params) || typeof params.query !== "string") {
            throw new Error("Expected mention directory query");
          }
          const query = params.query.toLowerCase();
          return {
            users: people.filter((person) => person.displayName.toLowerCase().includes(query)),
            truncated: false,
          };
        },
      }),
      run: async (page) => {
        const input = page.locator(composer);
        for (let cycle = 0; cycle < 4; cycle++) {
          await input.pressSequentially("@");
          const menu = page.getByRole("listbox", { name: "Mention a person" });
          await menu.getByRole("option").first().waitFor();
          await input.pressSequentially("Casey 2");
          await menu.getByRole("option").filter({ hasText: "Casey 29" }).waitFor();
          if ((await menu.getByRole("option").count()) !== 10) {
            throw new Error("Mention query did not narrow the directory to ten people");
          }
          await input.press("ArrowDown");
          const selectedName = await menu
            .locator('[aria-selected="true"] .slash-menu-name')
            .textContent();
          if (selectedName !== "Casey 21") {
            throw new Error(`Mention keyboard selection reached ${selectedName}`);
          }
          await input.press("Enter");
          if (!selectedName || !(await input.inputValue()).includes(`@${selectedName}`)) {
            throw new Error("Mention selection did not insert a person");
          }
          await input.press("ControlOrMeta+a");
          await input.press("Backspace");
        }
        return { cycles: 4, directoryPeople: 50 };
      },
    },
    {
      ...base,
      id: "chat-actions-search",
      expected: "Find transcript text and close search without losing the composer.",
      run: async (page) => {
        const draft = page.locator(composer);
        await draft.fill("Retained draft.");
        await draft.focus();
        await page.keyboard.press("ControlOrMeta+f");
        const input = page.locator(`${pane} .agent-chat__search-bar input`);
        await input.waitFor();
        await input.pressSequentially("message 17.");
        const result = page.locator(`${pane} .chat-text`);
        await result.getByText("Transcript 0 message 17.", { exact: false }).waitFor();
        if ((await result.count()) !== 1) {
          throw new Error("Transcript search did not filter to the matching message");
        }
        await input.press("Escape");
        await input.waitFor({ state: "hidden" });
        await page.waitForFunction(
          (selector) => document.querySelectorAll(selector).length > 1,
          `${pane} .chat-text`,
        );
        const restoredMessages = await result.count();
        if (
          (await draft.inputValue()) !== "Retained draft." ||
          !(await draft.evaluate((element) => element === document.activeElement))
        ) {
          throw new Error("Closing transcript search did not restore the focused draft");
        }
        return { queryCharacters: 11, matchingMessages: 1, restoredMessages };
      },
    },
    {
      ...base,
      id: "chat-actions-paste-text",
      expected:
        "Keep 256 KiB pasted text in the draft without attachments or sends; emulate DOM insertion and input events after an uncancelled synthetic paste, without measuring OS clipboard or native editing.",
      prepare: async (page) => {
        await prepareChat(page);
        await page.locator(composer).fill("Review this text.\n");
      },
      run: async (page, gateway) => {
        const input = page.locator(composer);
        const draft = await input.inputValue();
        const text = "Synthetic pasted text.\n".repeat(12_000).slice(0, 256 * 1024);
        const sendsBefore = (await gateway.getRequests("chat.send")).length;
        await input.click();
        await input.evaluate((element: HTMLTextAreaElement) => {
          element.setSelectionRange(element.value.length, element.value.length);
        });
        const uncancelled = await input.evaluate((element, value) => {
          const transfer = new DataTransfer();
          transfer.setData("text/plain", value);
          return element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            }),
          );
        }, text);
        if (!uncancelled) {
          throw new Error("Plain-text paste was cancelled instead of remaining draft input");
        }
        // Synthetic paste has no default action. Emulate the DOM edit and events;
        // beforeinput supplies the composer's edit intent before input commits it.
        await input.evaluate((element: HTMLTextAreaElement, value) => {
          const event = { bubbles: true, inputType: "insertFromPaste", data: value };
          if (
            !element.dispatchEvent(new InputEvent("beforeinput", { ...event, cancelable: true }))
          ) {
            throw new Error("Plain-text insertion was cancelled before updating the draft");
          }
          element.setRangeText(value, element.selectionStart, element.selectionEnd, "end");
          element.dispatchEvent(new InputEvent("input", event));
        }, text);
        await frames(page);
        const attachments = await page.locator(`${pane} .chat-attachment-remove`).count();
        const chatSends = (await gateway.getRequests("chat.send")).length - sendsBefore;
        if ((await input.inputValue()) !== draft + text || attachments !== 0 || chatSends !== 0) {
          throw new Error(
            "Plain-text paste did not preserve the exact unsent draft without attachments",
          );
        }
        return { pastedTextBytes: text.length, attachments, chatSends, pasteDefaultEmulated: true };
      },
    },
    ...(["text", "image"] as const).map((kind): EngineScenario =>
      Object.assign({}, base, {
        id: `chat-actions-native-paste-${kind}`,
        expected:
          kind === "text"
            ? "Insert 256 KiB through a trusted native paste, preserving the exact unsent draft."
            : "Attach and decode a 2048×2048 PNG through a trusted native paste.",
        prepare: async (page) => {
          await prepareChat(page);
          const input = page.locator(composer);
          await input.fill("Review this paste.\n");
          await input.focus();
          await input.evaluate((element: HTMLTextAreaElement) => {
            element.setSelectionRange(element.value.length, element.value.length);
          });
          // WebKit accepts clipboard-read only; evaluate supplies the write activation.
          const chromium = page.context().browser()!.browserType().name() === "chromium";
          await page
            .context()
            .grantPermissions(
              chromium ? ["clipboard-read", "clipboard-write"] : ["clipboard-read"],
            );
          // Clipboard preparation and PNG encoding stay outside the measured action.
          await page.evaluate(async (selected) => {
            const text = "Synthetic pasted text.\n".repeat(12_000).slice(0, 256 * 1024);
            if (selected === "text") {
              await navigator.clipboard.writeText(text);
              return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 2048;
            const context = canvas.getContext("2d")!;
            const pixels = context.createImageData(canvas.width, canvas.height);
            let seed = 0x12345678;
            // Seeded 2×2 color blocks keep the PNG large but below the 5 MiB image limit.
            for (let y = 0; y < canvas.height; y += 2) {
              for (let x = 0; x < canvas.width; x += 2) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                for (const offset of [0, 1, canvas.width, canvas.width + 1]) {
                  const index = (y * canvas.width + x + offset) * 4;
                  pixels.data[index] = seed & 255;
                  pixels.data[index + 1] = (seed >>> 8) & 255;
                  pixels.data[index + 2] = (seed >>> 16) & 255;
                  pixels.data[index + 3] = 255;
                }
              }
            }
            context.putImageData(pixels, 0, 0);
            const png = await new Promise<Blob>((resolve) => {
              canvas.toBlob((blob) => resolve(blob!), "image/png");
            });
            if (png.size < 2 * 1024 * 1024 || png.size > 5 * 1024 * 1024) {
              throw new Error(`Expected a 2–5 MiB synthetic PNG, encoded ${png.size} bytes`);
            }
            await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          }, kind);
        },
        run: async (page, gateway) => {
          const sendsBefore = (await gateway.getRequests("chat.send")).length;
          const input = page.locator(composer);
          const draft = await input.inputValue();
          const observation = await input.evaluateHandle(
            (element: HTMLTextAreaElement, { selected, prefix }) => {
              const pastedText = "Synthetic pasted text.\n".repeat(12_000).slice(0, 256 * 1024);
              const state: {
                result: {
                  nativePasteTrusted: boolean;
                  nativePasteReadyFrameMs: number;
                  nativePasteInputToReadyMs: number;
                  nativePasteDispatchMs: number;
                  nativePasteFrames: number;
                  pastedTextBytes: number;
                  pastedImageBytes: number;
                } | null;
              } = { result: null };
              let keyDownMs: number | undefined;
              const keyDown = (event: KeyboardEvent) => {
                if (
                  event.isTrusted &&
                  event.key.toLowerCase() === "v" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  keyDownMs = performance.now();
                }
              };
              document.addEventListener("keydown", keyDown, true);
              element.addEventListener(
                "paste",
                (event) => {
                  const start = performance.now();
                  document.removeEventListener("keydown", keyDown, true);
                  const pastedTextBytes = event.clipboardData!.getData("text/plain").length;
                  const pastedImageBytes = event.clipboardData!.files[0]?.size ?? 0;
                  let frameCount = 0;
                  const presented = () => {
                    frameCount++;
                    const image = element
                      .closest(".chat-pane-cache__pane--active")!
                      .querySelector<HTMLImageElement>(
                        '.chat-attachment-thumb[aria-busy="false"]:not(.chat-attachment-thumb--error) img',
                      );
                    const ready =
                      selected === "text"
                        ? element.value === prefix + pastedText
                        : image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
                    if (!ready) {
                      requestAnimationFrame(presented);
                      return;
                    }
                    state.result = {
                      nativePasteTrusted: event.isTrusted && keyDownMs !== undefined,
                      nativePasteReadyFrameMs: performance.now() - start,
                      nativePasteInputToReadyMs: performance.now() - (keyDownMs ?? start),
                      nativePasteDispatchMs: start - (keyDownMs ?? start),
                      nativePasteFrames: frameCount,
                      pastedTextBytes,
                      pastedImageBytes,
                    };
                  };
                  requestAnimationFrame(presented);
                },
                { once: true, capture: true },
              );
              return state;
            },
            { selected: kind, prefix: draft },
          );
          // The engine performs clipboard decoding/default editing; no event or DOM edit is injected.
          await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
          await page.waitForFunction((state) => state.result !== null, observation, {
            timeout: 15_000,
          });
          const evidence = await observation.evaluate((state) => state.result!);
          await observation.dispose();
          const attachments = await page.locator(`${pane} .chat-attachment-remove`).count();
          const chatSends = (await gateway.getRequests("chat.send")).length - sendsBefore;
          if (
            !evidence.nativePasteTrusted ||
            chatSends !== 0 ||
            attachments !== (kind === "image" ? 1 : 0) ||
            (kind === "text"
              ? evidence.pastedTextBytes !== 256 * 1024
              : !evidence.pastedImageBytes) ||
            (kind === "image" && (await input.inputValue()) !== draft)
          ) {
            throw new Error("Native paste did not preserve its trusted, exact unsent result");
          }
          return { ...evidence, attachments, chatSends };
        },
      } satisfies Partial<EngineScenario>),
    ),
    ...(["paste-image", "drop-image"] as const).map((kind): EngineScenario =>
      Object.assign({}, base, {
        id: `chat-actions-${kind}`,
        expected: `Attach a 2048×2048 PNG through the native ${kind.startsWith("paste") ? "paste" : "drop"} handler.`,
        prepare: async (page: Page) => {
          await prepareChat(page);
          await page.locator(composer).fill("Review these attachments.");
          // Image construction is setup; the measured handler still reads and prepares the file.
          await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 2048;
            canvas.height = 2048;
            canvas.getContext("2d")!.fillRect(0, 0, 2048, 2048);
            const encoded = canvas.toDataURL("image/png").split(",")[1]!;
            const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
            Reflect.set(
              window,
              "__chatActionFile",
              new File([bytes], "chat-action.png", { type: "image/png" }),
            );
          });
        },
        run: async (page: Page) => {
          // The trusted targeting gesture supplies the recent-input semantics of a
          // real paste/drop; the synthetic clipboard never reads the host clipboard.
          await page.locator(composer).click();
          await page.locator(composer).evaluate((element, selected) => {
            const transfer = new DataTransfer();
            transfer.items.add(Reflect.get(window, "__chatActionFile"));
            element.dispatchEvent(
              selected === "drop-image"
                ? new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })
                : new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: transfer,
                  }),
            );
          }, kind);
          const preview = page.locator(`${pane} .chat-attachments-preview`);
          await preview.waitFor({ state: "visible" });
          await preview.locator(".chat-attachment-remove").first().waitFor({ state: "visible" });
          const attachments = await preview.locator(".chat-attachment-remove").count();
          if (attachments !== 1) {
            throw new Error(`Expected one attachment, found ${attachments}`);
          }
          const ready = preview.locator(
            '.chat-attachment-thumb[aria-busy="false"]:not(.chat-attachment-thumb--error)',
          );
          await ready.waitFor();
          const image = ready.locator("img");
          await image.waitFor();
          await image.evaluate(async (element: HTMLImageElement) => {
            await element.decode();
            if (element.naturalWidth === 0 || element.naturalHeight === 0) {
              throw new Error("Attachment preview did not decode");
            }
          });
          return { attachments };
        },
      }),
    ),
  ];
}
