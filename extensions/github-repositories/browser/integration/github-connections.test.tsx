/** @jsxImportSource @solidjs/web */
/* @vitest-environment jsdom */

import type { ToolsGitHubStatusResult } from "@openclaw/gateway-protocol";
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../../ui/src/api/gateway.ts";
import { createAgentSelectionCapability } from "../../../../ui/src/app/agent-selection.ts";
import type {
  ApplicationContext,
  ApplicationGatewaySnapshot,
} from "../../../../ui/src/app/context.ts";
import { disconnectedGitHub } from "../../../../ui/src/pages/profile/profile-rpc.test-support.ts";
import { ControlUiSettingsSlot } from "../../../../ui/src/plugins/control-ui-settings-slot.solid.tsx";
import { gatewayHelloForMethods } from "../../../../ui/src/test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../../../ui/src/test-helpers/solid-application-context.tsx";
import { flush } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { waitForFast } from "../../../../ui/src/test-helpers/wait-for.ts";
import { settingsViews } from "../index.tsx";
import { createDeferred as createDeferredCore } from "./deferred.test-support.ts";
import { createMutationRunner } from "./github-identity-harness.test-support.ts";

const system: ToolsGitHubStatusResult["effective"] = {
  ...disconnectedGitHub.system,
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-account" },
  evidence: "github-api",
  refreshState: "available",
  repositoryGrants: "unknown",
};
const disconnected = disconnectedGitHub.personal;
const personalStatus = { personal: disconnected, system };
const unavailable = "Connection status unavailable";
const statusParams = (agentId: string) => ({ agentId, selectedScope: "system" as const });
const status = (agentId = "main", effective = system): ToolsGitHubStatusResult => ({
  ...statusParams(agentId),
  selected: { scope: "system", configured: true, identity: effective },
  effective,
});
const statusRequest = (effective = system) =>
  vi.fn(async (method: string) =>
    method === "users.github.status" ? personalStatus : status("main", effective),
  );
function expectText(element: Element | null, present: string[], absent: string[] = []) {
  // Row buttons show a short verb; their full name is what tells them apart.
  const names = [...(element?.querySelectorAll("button[aria-label]") ?? [])].map((button) =>
    button.getAttribute("aria-label"),
  );
  const content = [element?.textContent, ...names].join(" ");
  present.forEach((text) => expect(content).toContain(text));
  absent.forEach((text) => expect(content).not.toContain(text));
}
function mount(
  scopes: readonly string[],
  profileId: string | null,
  request: ReturnType<typeof vi.fn>,
  config: Record<string, unknown> | null = null,
) {
  const { gateway, publish } = createApplicationGateway({
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods(
      [
        "users.github.status",
        "tools.github.status",
        "tools.github.configure",
        "users.github.authorize.start",
        "tools.github.authorize.start",
      ],
      scopes,
    ),
    selfUser: profileId ? { id: profileId } : null,
  } as ApplicationGatewaySnapshot);
  const agents = {
    state: {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [
          { id: "main", name: "Clawd" },
          { id: "research", name: "Research" },
        ],
      },
    },
    subscribe: () => () => undefined,
  };
  const context = {
    plugins: {
      settingsContributions: settingsViews.map((view) => ({
        pluginId: "github-repositories",
        revision: "test",
        placement: view.placement,
      })),
      subscribe: () => () => {},
      reportError: vi.fn(),
      async loadSettingsView(placement: unknown, signal: AbortSignal) {
        return { view: settingsViews[0], signal, dispose() {} };
      },
    },
    basePath: "/ui",
    navigate: vi.fn(),
    gateway,
    agents,
    settingsAgentSelection: createAgentSelectionCapability(gateway, agents, undefined, undefined, {
      requireConfiguredAgent: true,
    }),
    runtimeConfig: {
      state: { configForm: config },
      subscribe: () => () => undefined,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
    },
  } as unknown as ApplicationContext;
  const { container: element } = mountSolid(
    () => <ControlUiSettingsSlot placement={{ section: "profile", panel: "connections" }} />,
    {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  const query = element.querySelector.bind(element);
  const button = (label: string) =>
    [...element.querySelectorAll("button")].find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    )!;
  const text = (present: string[], absent: string[] = []) => expectText(element, present, absent);
  return {
    element,
    context,
    query,
    text,
    waitText: (...args: Parameters<typeof text>) => waitForFast(() => text(...args)),
    row: (scope: string) => query(`[data-github-connection="${scope}"]`),
    button,
    openPat: () =>
      ["Change System GitHub", "Use a PAT instead"].forEach((label) => {
        button(label).click();
        flush();
      }),
    replaceProfile: (id: string) => {
      gateway.snapshot.selfUser = { ...gateway.snapshot.selfUser!, id };
      publish(gateway.snapshot);
    },
    emit(next: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...next });
      flush();
    },
  };
}

it.each([
  ["unchanged", ["operator.admin"]],
  ["admin revoked", ["operator.read"]],
  ["read revoked", []],
] as const)("reconciles GitHub reconnect authority: %s", async (access, scopes) => {
  const sharedIdentity = { ...system, account: { login: "admin-only-account" } };
  const request = statusRequest(sharedIdentity);
  const config = {
    tools: {},
    plugins: {
      entries: {
        "github-repositories": {
          config: {
            system: {
              profileId: "ghp_" + "a".repeat(32),
              gitAuthor: { name: "Configured author" },
            },
          },
        },
      },
    },
  };
  const harness = mount(["operator.admin"], "profile-a", request, config);
  const { text, waitText, query, button, openPat } = harness;
  await waitText(["@admin-only-account"]);
  openPat();
  const input = () => query<HTMLInputElement>('input[aria-label="Author Name"]');
  const token = () => query<HTMLInputElement>(".settings-secret input");
  expect(input()).not.toBeNull();
  input()!.value = "Draft author";
  input()!.dispatchEvent(new Event("input", { bubbles: true }));
  token()!.value = "synthetic-pat-draft";
  token()!.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  harness.context.runtimeConfig.state.configForm = null;
  harness.emit({ phase: "reconnecting" });
  const expectDraft = () => {
    expect(input()).toMatchObject({ value: "Draft author", disabled: true });
    expect(token()?.value).toBe("synthetic-pat-draft");
  };
  expectDraft();
  text(["@admin-only-account"]);
  const reconnect = {
    phase: "connected" as const,
    selfUser: undefined,
    hello: gatewayHelloForMethods(
      [
        "users.github.status",
        "tools.github.status",
        "tools.github.configure",
        "users.github.authorize.start",
        "tools.github.authorize.start",
      ],
      scopes,
    ),
  };
  harness.emit(reconnect);
  if (access === "unchanged") {
    expectDraft();
  } else {
    expect(query("[data-github-setup]")).toBeNull();
    text([], ["@admin-only-account"]);
    if (access === "read revoked") {
      text([], ["@system-account"]);
    }
    const reads = request.mock.calls.length;
    harness.emit(reconnect);
    text([], ["@admin-only-account"]);
    expect(request.mock.calls).toHaveLength(reads);
  }
  harness.context.runtimeConfig.state.configForm = config;
  harness.emit({ selfUser: { id: "profile-a" } });
  if (access !== "unchanged") {
    text([], ["@admin-only-account"]);
    expect(query("[data-github-setup]")).toBeNull();
    harness.emit({
      hello: gatewayHelloForMethods(
        [
          "users.github.status",
          "tools.github.status",
          "tools.github.configure",
          "users.github.authorize.start",
          "tools.github.authorize.start",
        ],
        ["operator.admin"],
      ),
    });
    await waitForFast(() => expect(button("Change System GitHub")?.disabled).toBe(false));
    openPat();
    expect(input()?.value).toBe("Configured author");
    expect(token()?.value).toBe("");
  }
  await waitForFast(() => expect(input()?.disabled).toBe(false));
  expect(input()?.value).toBe(access === "unchanged" ? "Draft author" : "Configured author");
  harness.emit({ selfUser: { id: "profile-b" } });
  expect(input()).toBeNull();
});

it.each([null, "profile-a"])("separates GitHub scopes for profile %s", async (profileId) => {
  const pending = createDeferredCore<ToolsGitHubStatusResult>();
  const agentStatus = (agentId: string): ToolsGitHubStatusResult => ({
    ...status(agentId),
    effective: { ...system, source: "agent-override", account: { login: `${agentId}-account` } },
  });
  const request = vi.fn(async (method: string, params: { agentId?: string }) =>
    method === "users.github.status"
      ? personalStatus
      : profileId && params.agentId === "main"
        ? pending.promise
        : agentStatus(params.agentId ?? "main"),
  );
  const { context, row, text, waitText } = mount(["operator.admin"], profileId, request);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      "tools.github.status",
      statusParams("main"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  const agent = () => row("agent");
  if (profileId) {
    context.settingsAgentSelection.set("research");
    await waitText(["GitHub for Research"]);
    await waitForFast(() => expectText(agent(), ["@research-account"]));
    pending.resolve(agentStatus("main"));
    await pending.promise;
    await new Promise<void>(queueMicrotask);
    expectText(agent(), [], ["@main-account"]);
    const personalReads = request.mock.calls.filter(([method]) => method === "users.github.status");
    expect(personalReads).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "tools.github.status",
      statusParams("research"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } else {
    await waitText(["@system-account"]);
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["tools.github.status", statusParams("main")],
    ]);
    text(["Personal sign-in required"], ["Connect My GitHub"]);
  }
  const agentId = profileId ? "research" : "main";
  expectText(row("system"), ["@system-account"], [`@${agentId}-account`]);
  expectText(agent(), [`@${agentId}-account`, "Agent override", "Verified"]);
  agent()?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: `/ui/settings/agents/${agentId}/tools`,
  });
});

it("shows one status failure during setup and retries without reconnecting the account", async () => {
  const error = "GitHub status temporarily unavailable";
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error(error))
    .mockResolvedValue({
      personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
      system,
    });
  const ui = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(ui.query('[role="alert"]')?.textContent).toContain(error));
  expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ["users.github.status", {}],
  ]);
  ui.text(
    ["Retry", unavailable],
    ["Change System GitHub", "Not verified", "Connect My GitHub", "Not connected"],
  );
  expectText(ui.row("system"), [unavailable]);
  ui.button("Manage connections").click();
  await waitForFast(() => expect(ui.query("[data-github-setup]")).not.toBeNull());
  expect(ui.element.querySelectorAll('[role="alert"]')).toHaveLength(1);
  ui.button("Retry").click();
  await ui.waitText(["@personal-account"]);
  expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ["users.github.status", {}],
    ["users.github.status", {}],
  ]);
  expect(ui.query('[role="alert"]')).toBeNull();
  ui.text(["Change My GitHub"]);
});

it.each(["available", "unavailable"] as const)("loads native %s", async (credentialState) => {
  const label = credentialState === "available" ? "Verified" : "No credentials";
  const pending = createDeferredCore<typeof personalStatus>();
  const request = vi.fn((_method: string, _params?: unknown) => pending.promise);
  const { text, waitText, context, row } = mount(["operator.read"], "profile-a", request);
  await waitText(["Checking connection…"]);
  text([], ["Not verified", "Connect My GitHub"]);
  pending.resolve({
    personal: disconnected,
    system: {
      ...system,
      source: "system-detected",
      credentialKind: "native",
      credentialState,
      account: credentialState === "available" ? system.account : null,
    },
  });
  await waitText(["Not connected"]);
  text(["Connect My GitHub"], ["Checking connection…"]);
  await waitForFast(() => expectText(row("system"), [label]));
  expectText(row("system"), [], ["OS account running the Gateway"]);
  if (credentialState !== "unavailable") {
    expectText(row("system"), [], ["No credentials"]);
  }
  text(
    ["Connect My GitHub", "Admin managed"],
    [unavailable, "Change System GitHub", "Use a PAT instead"],
  );
  expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ["users.github.status", {}],
  ]);
  expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
});

it("closes setup and resets its purpose when the same Gateway snapshot changes profile", async () => {
  const { query, button, replaceProfile } = mount(["operator.admin"], "profile-a", statusRequest());
  const setupRow = () => query("[data-github-setup]")?.closest("[data-github-connection]");
  const purpose = () => setupRow()?.getAttribute("data-github-connection");
  await waitForFast(() => expect(button("Change System GitHub").disabled).toBe(false));
  button("Change System GitHub").click();
  await waitForFast(() => expect(purpose()).toBe("system"));
  button("Use a PAT instead").click();
  await waitForFast(() => expect(query(".settings-secret input")).not.toBeNull());
  replaceProfile("profile-b");
  await waitForFast(() => expect(query("[data-github-setup]")).toBeNull());
  await waitForFast(() => expect(button("Connect My GitHub").disabled).toBe(false));
  button("Connect My GitHub").click();
  await waitForFast(() => expect(purpose()).toBe("personal"));
  expect(query(".settings-secret input")).toBeNull();
});

it("keeps unavailable canonical settings distinct from a loaded empty selection", async () => {
  const config = {
    plugins: {
      entries: {
        "github-repositories": {
          config: {
            system: { profileId: "ghp_" + "a".repeat(32), gitAuthor: { name: "Canonical author" } },
          },
        },
      },
    },
  };
  const harness = mount(["operator.admin"], "profile-a", statusRequest(), config);
  await harness.waitText(["@system-account"]);
  harness.openPat();
  const author = () => harness.query<HTMLInputElement>('input[aria-label="Author Name"]');
  expect(author()?.value).toBe("Canonical author");
  // A disconnected config read is not an authoritative identity deletion.
  harness.context.runtimeConfig.state.configForm = null;
  harness.emit({ phase: "reconnecting" });
  expect(author()).toMatchObject({ value: "Canonical author", disabled: true });
  // A successful empty load clears the old clean draft through the actual Settings slot.
  harness.context.runtimeConfig.state.configForm = {};
  harness.emit({ phase: "connected" });
  await harness.waitText(["@system-account"]);
  harness.openPat();
  expect(author()?.value).toBe("");
});

it("disables connection controls while a PAT save is pending", async () => {
  const stored = createDeferredCore<{ ok: boolean }>();
  const request = vi.fn(async (method: string) =>
    method === "secrets.store.set"
      ? stored.promise
      : method === "users.github.status"
        ? personalStatus
        : status(),
  );
  const ui = mount(["operator.admin"], "profile-a", request);
  vi.mocked(ui.context.runtimeConfig.runExternalMutation).mockImplementation(
    createMutationRunner(ui.context.gateway.snapshot.client!),
  );
  await ui.waitText(["@system-account"]);
  ui.openPat();
  const token = ui.query<HTMLInputElement>(".settings-secret input")!;
  token.value = "synthetic-pending-pat";
  token.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  ui.button("Save Identity").click();
  flush();
  try {
    await waitForFast(() => expect(ui.button("Saving…").disabled).toBe(true));
    expect(ui.button("Verify").disabled).toBe(true);
    expect(ui.button("Change System GitHub").disabled).toBe(true);
  } finally {
    stored.resolve({ ok: true });
  }
  await waitForFast(() => expect(ui.button("Verify").disabled).toBe(false));
});

it.each([false, true])(
  "settles a queued PAT save through the Settings facade (revoked: %s)",
  async (revoked) => {
    const queued = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    const savedIdentity = { ...system, account: { login: "saved-account" } };
    let saved = false;
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.configure") {
        saved = true;
      }
      const current = saved ? savedIdentity : system;
      return method === "users.github.status"
        ? { personal: disconnected, system: current }
        : status("main", current);
    });
    const ui = mount(["operator.admin"], "profile-a", request);
    const runMutation = createMutationRunner(ui.context.gateway.snapshot.client!);
    vi.mocked(ui.context.runtimeConfig.runExternalMutation).mockImplementation(
      async (task, options) => {
        queued.resolve();
        await release.promise;
        try {
          return await runMutation(task, options);
        } finally {
          settled.resolve();
        }
      },
    );
    await ui.waitText(["@system-account"]);
    ui.openPat();
    const token = ui.query<HTMLInputElement>(".settings-secret input")!;
    token.value = "synthetic-facade-pat";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    ui.button("Save Identity").click();
    await queued.promise;
    if (revoked) {
      ui.emit({
        hello: gatewayHelloForMethods(
          ["users.github.status", "tools.github.status", "tools.github.configure"],
          ["operator.read"],
        ),
      });
    }
    release.resolve();
    await settled.promise;
    const configured = request.mock.calls.filter(([method]) => method === "tools.github.configure");
    expect(configured).toHaveLength(revoked ? 0 : 1);
    expect(request.mock.calls.filter(([method]) => method === "secrets.store.set")).toHaveLength(
      revoked ? 0 : 1,
    );
    if (revoked) {
      ui.text([], ["@saved-account"]);
    } else {
      await ui.waitText(["@saved-account"]);
      expect(ui.query('[role="alert"]')).toBeNull();
    }
    expect(request.mock.calls.filter(([method]) => method === "secrets.store.delete")).toHaveLength(
      0,
    );
  },
);

it("opens setup under the connection it changes, with that connection's own actions", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.github.status"
      ? {
          personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
          system,
        }
      : status(),
  );
  const ui = mount(["operator.admin"], "profile-a", request);
  await ui.waitText(["@personal-account", "@system-account"]);
  ui.text([], ["Disconnect My GitHub", "Use native for new runs", "Manage connections"]);
  await waitForFast(() => expect(ui.button("Change My GitHub").disabled).toBe(false));

  ui.button("Change My GitHub").click();
  await waitForFast(() =>
    expect(ui.row("personal")?.querySelector("[data-github-setup]")).not.toBeNull(),
  );
  expectText(ui.row("personal"), ["Disconnect My GitHub"], ["Use native for new runs"]);

  ui.button("Change System GitHub").click();
  await waitForFast(() =>
    expect(ui.row("system")?.querySelector("[data-github-setup]")).not.toBeNull(),
  );
  expect(ui.row("personal")?.querySelector("[data-github-setup]")).toBeNull();
  expectText(ui.row("system"), ["Use native for new runs"], ["Disconnect My GitHub"]);

  ui.button("Close").click();
  await waitForFast(() => expect(ui.query("[data-github-setup]")).toBeNull());
});

it("labels a read-only App installation without promising command execution or publication", async () => {
  const ui = mount(
    ["operator.admin"],
    "owner",
    statusRequest({
      ...system,
      credentialKind: "app-installation",
      account: { login: "reader[bot]" },
      refreshState: "not_applicable",
    }),
  );
  await ui.waitText(["@reader[bot]"]);
  expectText(
    ui.row("system"),
    ["GitHub App installation"],
    ["Agent commands, dashboards, publishing"],
  );
});
