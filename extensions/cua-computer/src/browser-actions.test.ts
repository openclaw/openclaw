import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { driver, execution, type ComputerExecution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES as fixtures,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import type { CuaToolResult } from "./driver-client.js";

async function bindBrowser(computer: ComputerExecution) {
  const { details } = await computer.read<{
    details: { browserRef: string; pages: Array<{ pageRef: string }> };
  }>("get_browser_state", { windowRef: await computer.window() });
  return { browserRef: details.browserRef, pageRef: details.pages[0]!.pageRef };
}

type BrowserObservation = {
  observation: { observationId: string };
  details: { elements: Array<{ elementRef: string }> };
};
const observeBrowser = (
  computer: ComputerExecution,
  target: Awaited<ReturnType<typeof bindBrowser>>,
) => computer.read<BrowserObservation>("get_browser_state", target);

function browserDriver(
  snapshot = () => cuaToolResult(fixtures.browserSnapshot),
  fallback = () => cuaToolResult(fixtures.browserNavigate),
) {
  const active = driver();
  active.callTool.mockImplementation(async (name, args) => {
    if (name === "list_windows") {
      return cuaToolResult(fixtures.listWindows);
    }
    if (name === "get_browser_state") {
      return "target_id" in args ? snapshot() : cuaToolResult(fixtures.browserBinding);
    }
    return fallback();
  });
  return active;
}

describe("cua-computer browser actions", () => {
  it("maps every browser action to the pinned driver tool contract", async () => {
    const { session, callTool } = driver();
    let downloadedFile = "";
    const binding = {
      ...fixtures.browserBinding,
      tabs: fixtures.browserBinding.tabs.map((tab) => ({
        ...tab,
        title: "",
        active: false,
        nativeSession: "private-native-browser-session",
      })),
    };
    const snapshot = {
      ...fixtures.browserSnapshot,
      refs: fixtures.browserSnapshot.refs.map((ref) => ({
        ...ref,
        value: "",
        states: [],
        nativeSession: "private-native-browser-session",
      })),
      content_refs: [{ ref: "p7:0", label: "duplicate action reference" }],
    };
    callTool.mockImplementation(async (name, args) => {
      switch (name) {
        case "list_windows":
          return cuaToolResult(fixtures.listWindows);
        case "get_browser_state":
          return cuaToolResult("target_id" in args ? snapshot : binding, {
            image: "target_id" in args,
          });
        case "browser_prepare":
          return cuaToolResult(fixtures.browserPrepare);
        case "browser_navigate":
          return cuaToolResult(fixtures.browserNavigate);
        case "browser_dialog":
          return cuaToolResult(fixtures.browserDialog);
        case "browser_set_input_files":
          return cuaToolResult(fixtures.browserFiles);
        case "browser_download":
          downloadedFile = path.join(String(args.destination_root), "download.txt");
          await fs.writeFile(downloadedFile, "download");
          return cuaToolResult(fixtures.browserDownload);
        case "browser_click":
        case "browser_type":
        case "browser_pointer":
          return cuaToolResult(
            {},
            { action: fixtures.confirmedBackgroundAction as unknown as CuaToolResult["action"] },
          );
        default:
          return cuaToolResult({});
      }
    });
    const computer = await execution(session);
    const windowRef = await computer.window();

    await computer.send("browser_prepare", {
      windowRef,
      profile: "isolated_named",
      profileName: "openclaw-test",
    });
    const boundJson = await computer.send("get_browser_state", { windowRef });
    expect(boundJson).not.toContain("native-browser-target-1");
    expect(boundJson).not.toContain("native-page-1");
    expect(boundJson).not.toContain("private-native-browser-session");
    const bound = JSON.parse(boundJson) as {
      details: { browserRef: string; pages: Array<{ pageRef: string }> };
    };
    expect(bound.details.browserRef).toMatch(/^cua:v2:browser:/);
    expect(bound.details.pages[0]!.pageRef).toMatch(/^cua:v2:page:/);
    expect(bound.details.pages).toEqual([
      { pageRef: expect.any(String), title: "", url: "https://example.com/", active: false },
    ]);
    const browserRef = bound.details.browserRef;
    const pageRef = bound.details.pages[0]!.pageRef;
    const target = { browserRef, pageRef };

    const observedJson = await computer.send("get_browser_state", { browserRef, pageRef });
    expect(observedJson).not.toContain("p7:0");
    expect(observedJson).not.toContain("private-native-browser-session");
    const observed = JSON.parse(observedJson) as {
      observation: { kind: string; observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    expect(observed.observation.kind).toBe("browser");
    const expectedElement = {
      elementRef: expect.any(String),
      kind: "action",
      value: "",
      states: [],
      frame: "main",
    };
    expect(observed.details.elements).toEqual([
      { ...expectedElement, node: "BUTTON", label: "Continue" },
      { ...expectedElement, node: "INPUT", label: "Name" },
    ]);
    const observationId = observed.observation.observationId;
    const observedTarget = { ...target, observationId };
    const [firstElement, secondElement] = observed.details.elements.map(
      (element) => element.elementRef,
    );
    expect(firstElement).toMatch(/^cua:v2:element:/);

    await computer.send("browser_click", {
      ...observedTarget,
      elementRef: firstElement,
      inputRoute: "dom_event",
    });
    await computer.send("browser_type", {
      ...observedTarget,
      elementRef: secondElement,
      text: "hello",
      mode: "keystrokes",
      replace: true,
    });
    const dialog = JSON.parse(
      await computer.send("browser_dialog", { ...target, dialogAction: "inspect" }),
    ) as { details: { dialogRef: string } };
    expect(dialog.details.dialogRef).toMatch(/^cua:v2:dialog:/);
    const downloadJson = await computer.send("browser_download", {
      ...observedTarget,
      elementRef: firstElement,
    });
    expect(downloadJson).not.toContain(path.dirname(downloadedFile));
    const download = JSON.parse(downloadJson) as {
      details: { fileResourceHandles: string[]; resourceHandle: string };
    };
    expect(download.details.resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);
    expect(download.details.fileResourceHandles[0]).toMatch(/^openclaw:computer-resource:v1:/u);
    await computer.send("browser_set_input_files", {
      ...observedTarget,
      elementRef: secondElement,
      resourceHandles: download.details.fileResourceHandles,
    });
    await computer.send("browser_pointer", {
      ...observedTarget,
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: firstElement,
      destinationElementRef: secondElement,
    });
    await computer.send("browser_navigate", { ...target, url: "https://example.com/next" });

    const nativeTarget = { target_id: "native-browser-target-1", tab_id: "native-page-1" };
    const call = (tool: string, args: Record<string, unknown>) => [tool, args, undefined];
    expect(callTool.mock.calls).toEqual([
      call("list_windows", {}),
      call("browser_prepare", {
        pid: 4242,
        allow_launch: true,
        profile: { mode: "isolated_named", name: "openclaw-test" },
      }),
      call("get_browser_state", { pid: 4242, window_id: 99 }),
      call("get_browser_state", {
        ...nativeTarget,
        snapshot_format: "dom_refs_v1",
        include_screenshot: true,
      }),
      call("browser_click", { ...nativeTarget, ref: "p7:0", input_route: "dom_event" }),
      call("browser_type", {
        ...nativeTarget,
        ref: "p7:1",
        text: "hello",
        mode: "keystrokes",
        replace: true,
      }),
      call("browser_dialog", { ...nativeTarget, action: "inspect" }),
      call("browser_download", {
        ...nativeTarget,
        ref: "p7:0",
        destination_root: path.dirname(downloadedFile),
      }),
      call("browser_set_input_files", { ...nativeTarget, ref: "p7:1", files: [downloadedFile] }),
      call("browser_pointer", {
        ...nativeTarget,
        action: "drag",
        input_route: "dom_event",
        ref: "p7:0",
        destination_ref: "p7:1",
      }),
      call("browser_navigate", { ...nativeTarget, url: "https://example.com/next" }),
    ]);

    await computer.close("cancel");
    await expect(fs.access(downloadedFile)).rejects.toThrow();
  });

  it("invalidates browser capabilities across navigation, generation, and execution", async () => {
    const first = browserDriver();
    const computer = await execution(first.session);
    const target = await bindBrowser(computer);
    const { browserRef, pageRef } = target;
    const observed = await observeBrowser(computer, target);
    const staleAction = {
      action: "browser_click",
      browserRef,
      pageRef,
      observationId: observed.observation.observationId,
      elementRef: observed.details.elements[0]!.elementRef,
    };

    const callsBeforeForgedRefs = first.callTool.mock.calls.length;
    for (const forged of [
      { ...staleAction, browserRef: "/tmp/native-browser-target" },
      { ...staleAction, pageRef: "../native-page" },
      { ...staleAction, observationId: "/tmp/native-observation" },
      { ...staleAction, elementRef: "p7:0" },
    ]) {
      await expect(computer.send(forged)).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    }
    expect(first.callTool).toHaveBeenCalledTimes(callsBeforeForgedRefs);

    await computer.send("browser_navigate", { browserRef, pageRef, url: "about:blank" });
    await expect(computer.send(staleAction)).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    first.setGeneration("execution-2");
    await expect(computer.send("get_browser_state", { browserRef, pageRef })).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );

    const second = await execution(first.session);
    await expect(second.send("get_browser_state", { browserRef, pageRef })).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );
  });

  it("keeps existing-profile browser attachment outside the accepted contract", async () => {
    const { session, callTool } = driver();
    callTool.mockResolvedValueOnce(cuaToolResult(fixtures.listWindows));
    const computer = await execution(session);
    const windowRef = await computer.window();

    await expect(
      computer.send("browser_prepare", { windowRef, profile: "existing_profile" }),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    await expect(
      computer.send("browser_prepare", { windowRef, strategy: { kind: "existing_profile" } }),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rechecks browser generation and structured stale refusals after driver calls", async () => {
    let staleOnSnapshot = true;
    const active = browserDriver(
      () => {
        if (staleOnSnapshot) {
          active.setGeneration("execution-2");
        }
        return cuaToolResult(fixtures.browserSnapshot);
      },
      () =>
        cuaToolResult({
          status: "refused",
          refusal: { code: "browser_ref_stale", message: "page changed" },
        }),
    );
    const computer = await execution(active.session);
    const firstBinding = await bindBrowser(computer);
    await expect(
      computer.send("get_browser_state", {
        ...firstBinding,
      }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    staleOnSnapshot = false;
    const target = await bindBrowser(computer);
    const { browserRef, pageRef } = target;
    const observed = await observeBrowser(computer, target);
    await expect(
      computer.send("browser_click", {
        browserRef,
        pageRef,
        observationId: observed.observation.observationId,
        elementRef: observed.details.elements[0]!.elementRef,
      }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });
});
