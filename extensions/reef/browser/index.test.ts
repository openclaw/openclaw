/* @vitest-environment jsdom */

import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type Status = {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  handle: string | null;
  relayUrl: string;
  unavailableReason?: string;
  friends: Array<{ peer: string; status: string; autonomy: string | null }>;
  mounts: Array<{
    mountId: string;
    peer: string;
    role: "host" | "guest";
    sessionKey: string;
    revoked: boolean;
    revocationPending: boolean;
  }>;
  proposals: Array<{
    direction: "inbound" | "outbound";
    peer: string;
    text: string;
    status: "pending" | "accepted" | "denied" | "failed";
    reason: string | null;
    message: string | null;
  }>;
};

const unconfigured: Status = {
  enabled: false,
  configured: false,
  running: false,
  handle: null,
  relayUrl: "https://reefwire.ai",
  friends: [],
  mounts: [],
  proposals: [],
};

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function activate(
  status: Status,
  sessions = {
    rows: [{ key: "agent:main:shared", label: "Shared plan" }],
    selectedKey: "agent:main:shared",
  },
) {
  let mount: ControlUiView | undefined;
  const request = vi.fn().mockResolvedValue(status);
  const host = {
    apiVersion: 1,
    pluginId: "reef",
    signal: new AbortController().signal,
    basePath: "",
    locale: "en",
    connection: {
      connected: true,
      canRead: true,
      canWrite: true,
      canGrant: true,
      canAdmin: true,
      assistantAgentId: "main",
    },
    request,
    sessions,
    agents: {
      rows: [],
      selectedId: "main",
      defaultId: "main",
      scopeId: null,
    },
    ui: {
      registerPage: vi.fn((page: { mount: ControlUiView }) => {
        mount = page.mount;
        return vi.fn();
      }),
      registerNavigation: vi.fn(() => vi.fn()),
    },
  } as unknown as ControlUiHost;
  const dispose = plugin.activate(host);
  if (!mount) {
    throw new Error("Reef page was not registered");
  }
  const container = document.createElement("main");
  document.body.append(container);
  const context = {
    host,
    signal: host.signal,
    props: {},
    presented: true,
    mountDefault: () => vi.fn(),
  };
  const view = mount(container, context);
  return { container, context, dispose, host, request, view };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Reef native Control UI", () => {
  it("does not register its admin page or navigation for read-only operators", () => {
    const registerPage = vi.fn();
    const registerNavigation = vi.fn();

    plugin.activate({
      connection: { canAdmin: false },
      ui: { registerPage, registerNavigation },
    } as unknown as ControlUiHost);

    expect(registerPage).not.toHaveBeenCalled();
    expect(registerNavigation).not.toHaveBeenCalled();
  });

  it("shows actionable setup without fabricating channel availability", async () => {
    const page = activate(unconfigured);

    await vi.waitFor(() => expect(page.container.textContent).toContain("Finish Reef setup"));
    expect(page.container.textContent).toContain("explicitly enable it");
    expect(
      page.container.querySelector<HTMLAnchorElement>('a[href="/channels"]')?.textContent,
    ).toBe("Open channel setup");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("explains a configured channel that is currently unavailable", async () => {
    const page = activate({
      ...unconfigured,
      enabled: true,
      configured: true,
      handle: "host",
      unavailableReason: "Relay connection closed",
    });

    await vi.waitFor(() =>
      expect(page.container.textContent).toContain("Reef is configured but unavailable"),
    );
    expect(page.container.textContent).toContain("Relay connection closed");
    expect(page.container.textContent).not.toContain("Share session");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("links a configured but disabled channel back to setup", async () => {
    const page = activate({
      ...unconfigured,
      configured: true,
      handle: "host",
    });

    await vi.waitFor(() =>
      expect(page.container.textContent).toContain("Reef is configured but disabled"),
    );
    expect(page.container.textContent).toContain("Enable Reef in Channels");
    expect(
      page.container.querySelector<HTMLAnchorElement>('a[href="/channels"]')?.textContent,
    ).toBe("Open channel setup");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("keeps successful action feedback visible after refreshing status", async () => {
    const running: Status = {
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
    };
    const page = activate(running);

    await vi.waitFor(() => expect(page.container.textContent).toContain("Request pairing"));
    page.request
      .mockResolvedValueOnce({ message: "Pairing requested." })
      .mockResolvedValueOnce(running);
    findButton(page.container, "Request pairing")?.click();

    await vi.waitFor(() => expect(page.container.textContent).toContain("Pairing requested."));

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("shows direct action request failures", async () => {
    const page = activate({
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
    });

    await vi.waitFor(() => expect(page.container.textContent).toContain("Generate friend code"));
    page.request.mockRejectedValueOnce(new Error("Friend code unavailable"));
    findButton(page.container, "Generate friend code")?.click();

    await vi.waitFor(() => expect(page.container.textContent).toContain("Friend code unavailable"));

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("defaults session sharing to the selected session's canonical agent key", async () => {
    const running: Status = {
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
      friends: [{ peer: "guest", status: "active", autonomy: "bounded" }],
    };
    const page = activate(running, {
      rows: [
        { key: "global", label: "Other agent", agentId: "other" },
        { key: "global", label: "Selected agent", agentId: "main" },
      ],
      selectedKey: "global",
    });

    await vi.waitFor(() => expect(page.container.textContent).toContain("Share session"));
    const sessionInput = [...page.container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.closest("label")?.textContent?.includes("Host session key"),
    );
    expect(sessionInput?.value).toBe("agent:main:global");
    page.request.mockResolvedValueOnce({ message: "Shared." }).mockResolvedValueOnce(running);
    findButton(page.container, "Share session")?.click();

    await vi.waitFor(() =>
      expect(page.request).toHaveBeenCalledWith("reef.controlUi.sessionShare", {
        peer: "guest",
        sessionKey: "agent:main:global",
      }),
    );

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("replaces stale controls when a host-driven status refresh fails", async () => {
    const page = activate({
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
    });

    await vi.waitFor(() => expect(page.container.textContent).toContain("Share session"));
    page.request.mockRejectedValueOnce(new Error("Status refresh failed"));
    page.view?.update?.(page.context);

    await vi.waitFor(() => expect(page.container.textContent).toContain("Status refresh failed"));
    expect(page.container.textContent).not.toContain("Share session");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("does not let an older status response overwrite newer state", async () => {
    const running: Status = {
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
    };
    const disabled: Status = {
      ...running,
      enabled: false,
      running: false,
    };
    const older = deferred<Status>();
    const page = activate(running);

    await vi.waitFor(() => expect(page.container.textContent).toContain("Share session"));
    page.request.mockReturnValueOnce(older.promise).mockResolvedValueOnce(disabled);
    page.view?.update?.(page.context);
    page.view?.update?.(page.context);

    await vi.waitFor(() =>
      expect(page.container.textContent).toContain("Reef is configured but disabled"),
    );
    older.resolve(running);
    await older.promise;
    await Promise.resolve();
    expect(page.container.textContent).not.toContain("Share session");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("clears stale controls when a post-action status refresh fails", async () => {
    const running: Status = {
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
    };
    const page = activate(running);

    await vi.waitFor(() => expect(page.container.textContent).toContain("Request pairing"));
    page.request
      .mockResolvedValueOnce({ message: "Pairing requested." })
      .mockRejectedValueOnce(new Error("Status refresh failed"));
    findButton(page.container, "Request pairing")?.click();

    await vi.waitFor(() => expect(page.container.textContent).toContain("Pairing requested."));
    expect(page.container.textContent).toContain("Status refresh failed");
    expect(page.container.textContent).not.toContain("Request pairing");
    expect(page.container.textContent).not.toContain("Share session");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("renders a pending revocation without another mount action", async () => {
    const page = activate({
      ...unconfigured,
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
      mounts: [
        {
          mountId: "mount-host",
          peer: "guest",
          role: "host",
          sessionKey: "agent:main:shared",
          revoked: true,
          revocationPending: true,
        },
      ],
    });

    await vi.waitFor(() => expect(page.container.textContent).toContain("Revocation pending"));
    expect(findButton(page.container, "Revoke access")).toBeUndefined();

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });

  it("renders mounts and text-only proposal outcomes on the running surface", async () => {
    const page = activate({
      enabled: true,
      configured: true,
      running: true,
      handle: "host",
      relayUrl: "http://127.0.0.1:36641",
      friends: [{ peer: "guest", status: "active", autonomy: "bounded" }],
      mounts: [
        {
          mountId: "mount-host",
          peer: "guest",
          role: "host",
          sessionKey: "agent:main:shared",
          revoked: false,
          revocationPending: false,
        },
        {
          mountId: "mount-guest",
          peer: "host",
          role: "guest",
          sessionKey: "agent:host:shared",
          revoked: false,
          revocationPending: false,
        },
      ],
      proposals: [
        {
          direction: "inbound",
          peer: "guest",
          text: "Use the real host transcript",
          status: "pending",
          reason: null,
          message: null,
        },
        {
          direction: "outbound",
          peer: "host",
          text: "Return the proof marker",
          status: "accepted",
          reason: null,
          message: null,
        },
      ],
    });

    await vi.waitFor(() => expect(page.container.textContent).toContain("Connected"));
    expect(page.container.textContent).toContain("Share a host session");
    expect(page.container.textContent).toContain("Mounted from @host");
    expect(page.container.textContent).toContain("Use the real host transcript");
    expect(page.container.textContent).toContain("pending");
    expect(page.container.textContent).toContain("accepted");
    expect(
      page.container.querySelector<HTMLAnchorElement>('a[href="/approvals"]')?.textContent,
    ).toBe("Open approvals");
    expect(page.container.textContent).not.toContain("assistant reply");

    page.view?.dispose?.();
    if (typeof page.dispose === "function") {
      page.dispose();
    }
  });
});
