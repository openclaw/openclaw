import { defineControlUiPlugin, type ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import "./reef.css";

type ReefStatus = {
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

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) {
    value.className = className;
  }
  if (text !== undefined) {
    value.textContent = text;
  }
  return value;
}

function action(
  label: string,
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  secondary = false,
): HTMLButtonElement {
  const value = node(
    "button",
    secondary ? "reef-button reef-button--secondary" : "reef-button",
    label,
  );
  value.type = "button";
  value.addEventListener("click", () => {
    value.disabled = true;
    void run()
      .catch(onError)
      .finally(() => {
        value.disabled = false;
      });
  });
  return value;
}

function field(label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const value = node("label", "reef-field");
  value.append(node("span", "reef-field__label", label), control);
  return value;
}

function createReefPage(host: ControlUiHost) {
  return (container: HTMLElement) => {
    let disposed = false;
    let renderGeneration = 0;
    const page = node("div", "reef-page");
    const notices = node("div", "reef-notices");
    const root = node("div", "reef-content");
    page.append(notices, root);
    container.replaceChildren(page);

    const request = async <T>(method: string, params: Record<string, unknown> = {}) =>
      await host.request<T>(method, params);
    const notice = (message: string, error = false) => {
      const value = node("div", error ? "reef-notice reef-notice--error" : "reef-notice", message);
      notices.prepend(value);
      window.setTimeout(() => value.remove(), 6000);
    };
    const reportError = (error: unknown) => {
      notice(error instanceof Error ? error.message : "Reef action failed.", true);
    };

    const render = async () => {
      const generation = ++renderGeneration;
      let status: ReefStatus;
      try {
        status = await request<ReefStatus>("reef.controlUi.status");
      } catch (error) {
        if (disposed || generation !== renderGeneration) {
          return;
        }
        throw error;
      }
      if (disposed || generation !== renderGeneration) {
        return;
      }
      root.replaceChildren();

      const hero = node("section", "reef-hero");
      const copy = node("div");
      copy.append(
        node("p", "reef-eyebrow", "PRIVATE CLAW FEDERATION"),
        node("h1", "reef-title", "Reef"),
        node(
          "p",
          "reef-subtitle",
          "Pair trusted claws and share selected sessions without moving the host transcript.",
        ),
      );
      const identity = node("div", "reef-identity");
      identity.append(
        node(
          "span",
          `reef-status reef-status--${status.running ? "online" : "offline"}`,
          status.running ? "Connected" : "Unavailable",
        ),
        node("strong", "reef-handle", status.handle ? `@${status.handle}` : "Not configured"),
        node("span", "reef-muted", status.relayUrl),
      );
      hero.append(copy, identity);
      root.append(hero);

      if (!status.configured) {
        const empty = node("section", "reef-card reef-empty");
        empty.append(
          node("h2", undefined, "Finish Reef setup"),
          node(
            "p",
            undefined,
            "Register a handle, relay, and guard model in Channels. Reef remains off until you explicitly enable it.",
          ),
        );
        const link = node("a", "reef-button", "Open channel setup");
        link.href = `${host.basePath || ""}/channels`;
        empty.append(link);
        root.append(empty);
        return;
      }

      if (!status.enabled) {
        const empty = node("section", "reef-card reef-empty");
        empty.append(
          node("h2", undefined, "Reef is configured but disabled"),
          node("p", undefined, "Enable Reef in Channels before connecting to the relay."),
        );
        const link = node("a", "reef-button", "Open channel setup");
        link.href = `${host.basePath || ""}/channels`;
        empty.append(link);
        root.append(empty);
        return;
      }

      if (!status.running) {
        const empty = node("section", "reef-card reef-empty");
        empty.append(
          node("h2", undefined, "Reef is configured but unavailable"),
          node(
            "p",
            undefined,
            status.unavailableReason ?? "Check the channel status and relay connection.",
          ),
          action("Check again", render, reportError, true),
        );
        root.append(empty);
        return;
      }

      const run = async (method: string, params: Record<string, unknown> = {}) => {
        let result: { message: string };
        try {
          result = await request<{ message: string }>(method, params);
        } catch (error) {
          reportError(error);
          return;
        }
        try {
          await render();
          notice(result.message);
        } catch (error) {
          renderError(error);
          notice(result.message);
          reportError(error);
        }
      };

      const grid = node("div", "reef-grid");
      const pair = node("section", "reef-card");
      pair.append(node("h2", undefined, "Pair a claw"));
      const codeOutput = node("output", "reef-code", "Generate a short-lived friend code.");
      pair.append(
        codeOutput,
        action(
          "Generate friend code",
          async () => {
            const result = await request<{ message: string }>("reef.controlUi.friendCode");
            codeOutput.textContent = result.message;
          },
          reportError,
        ),
      );
      const peer = node("input");
      peer.placeholder = "@handle";
      const code = node("input");
      code.placeholder = "Friend code";
      pair.append(
        field("Friend handle", peer),
        field("Code", code),
        action(
          "Request pairing",
          () =>
            run("reef.controlUi.friendRequest", {
              peer: peer.value,
              code: code.value || undefined,
            }),
          reportError,
        ),
      );

      const share = node("section", "reef-card");
      share.append(node("h2", undefined, "Share a host session"));
      const friendSelect = node("select");
      for (const friend of status.friends.filter((entry) => entry.status === "active")) {
        const option = node("option", undefined, `@${friend.peer}`);
        option.value = friend.peer;
        friendSelect.append(option);
      }
      const sessionInput = node("input");
      sessionInput.placeholder = "agent:main:session-key";
      const selectedAgentId = host.agents.selectedId;
      const selectedRow = host.sessions.rows.find(
        (session) =>
          session.key === host.sessions.selectedKey &&
          (!selectedAgentId || session.agentId === selectedAgentId),
      );
      const canonicalAgentId = selectedRow?.agentId ?? selectedAgentId;
      sessionInput.value = host.sessions.selectedKey.startsWith("agent:")
        ? host.sessions.selectedKey
        : canonicalAgentId
          ? `agent:${canonicalAgentId}:${host.sessions.selectedKey}`
          : "";
      const shareAction = action(
        "Share session",
        () =>
          run("reef.controlUi.sessionShare", {
            peer: friendSelect.value,
            sessionKey: sessionInput.value,
          }),
        reportError,
      );
      const syncShareAction = () => {
        shareAction.disabled = !friendSelect.value || !sessionInput.value.trim();
      };
      friendSelect.addEventListener("change", syncShareAction);
      sessionInput.addEventListener("input", syncShareAction);
      syncShareAction();
      share.append(
        field("Trusted claw", friendSelect),
        field("Host session key", sessionInput),
        shareAction,
      );
      grid.append(pair, share);
      root.append(grid);

      root.append(
        renderFriends(status, run, reportError),
        renderMounts(status, run, reportError),
        renderProposals(status, host),
      );
    };

    const renderError = (error: unknown) => {
      root.replaceChildren(
        node(
          "section",
          "reef-card reef-empty",
          error instanceof Error ? error.message : "Could not load Reef.",
        ),
      );
    };
    void render().catch(renderError);
    return {
      update: () => void render().catch(renderError),
      dispose: () => void (disposed = true),
    };
  };
}

function renderFriends(
  status: ReefStatus,
  run: (method: string, params?: Record<string, unknown>) => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const card = node("section", "reef-card");
  card.append(node("h2", undefined, `Trusted claws · ${status.friends.length}`));
  const list = node("div", "reef-list");
  for (const friend of status.friends) {
    const row = node("article", "reef-row");
    const copy = node("div");
    copy.append(
      node("strong", undefined, `@${friend.peer}`),
      node(
        "span",
        "reef-muted",
        `${friend.status} · ${friend.autonomy ?? "autonomy not approved"}`,
      ),
    );
    row.append(
      copy,
      action(
        "Remove",
        () => run("reef.controlUi.friendRemove", { peer: friend.peer }),
        reportError,
        true,
      ),
    );
    list.append(row);
  }
  if (!status.friends.length) {
    list.append(node("p", "reef-muted", "No trusted claws yet."));
  }
  card.append(list);
  return card;
}

function renderMounts(
  status: ReefStatus,
  run: (method: string, params?: Record<string, unknown>) => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const card = node("section", "reef-card");
  card.append(node("h2", undefined, `Session mounts · ${status.mounts.length}`));
  const list = node("div", "reef-list");
  for (const mount of status.mounts) {
    const row = node("article", "reef-row reef-row--stack");
    const head = node("div", "reef-row__head");
    const mountState = mount.revocationPending ? "pending" : mount.revoked ? "revoked" : "active";
    head.append(
      node(
        "strong",
        undefined,
        `${mount.role === "host" ? "Shared with" : "Mounted from"} @${mount.peer}`,
      ),
      node(
        "span",
        `reef-pill reef-pill--${mountState}`,
        mount.revocationPending ? "Revocation pending" : mount.revoked ? "Revoked" : mount.role,
      ),
    );
    row.append(
      head,
      node("code", undefined, mount.sessionKey),
      node("small", "reef-muted", mount.mountId),
    );
    if (mount.role === "host" && !mount.revoked && !mount.revocationPending) {
      row.append(
        action(
          "Revoke access",
          () => run("reef.controlUi.sessionRevoke", { mountId: mount.mountId }),
          reportError,
          true,
        ),
      );
    } else if (mount.role === "guest" && !mount.revoked && !mount.revocationPending) {
      const prompt = node("textarea");
      prompt.placeholder = "Propose a text prompt to the host session";
      row.append(
        field("Prompt proposal", prompt),
        action(
          "Send proposal",
          () => run("reef.controlUi.sessionPrompt", { mountId: mount.mountId, text: prompt.value }),
          reportError,
        ),
      );
    }
    list.append(row);
  }
  if (!status.mounts.length) {
    list.append(node("p", "reef-muted", "No shared session mounts."));
  }
  card.append(list);
  return card;
}

function renderProposals(status: ReefStatus, host: ControlUiHost) {
  const card = node("section", "reef-card");
  const heading = node("div", "reef-section-heading");
  heading.append(node("h2", undefined, `Prompt proposals · ${status.proposals.length}`));
  const approvals = node("a", "reef-link", "Open approvals");
  approvals.href = `${host.basePath || ""}/approvals`;
  heading.append(approvals);
  card.append(heading);
  const list = node("div", "reef-list");
  for (const proposal of status.proposals.toReversed()) {
    const row = node("article", "reef-row reef-row--stack");
    const head = node("div", "reef-row__head");
    head.append(
      node(
        "strong",
        undefined,
        `${proposal.direction === "inbound" ? "From" : "To"} @${proposal.peer}`,
      ),
      node("span", `reef-pill reef-pill--${proposal.status}`, proposal.status),
    );
    row.append(head, node("p", "reef-prompt", proposal.text));
    if (proposal.reason || proposal.message) {
      row.append(node("small", "reef-muted", proposal.reason ?? proposal.message ?? ""));
    }
    list.append(row);
  }
  if (!status.proposals.length) {
    list.append(
      node(
        "p",
        "reef-muted",
        "No prompt proposals yet. Guest prompts appear here as pending, accepted, denied, or failed.",
      ),
    );
  }
  card.append(list);
  return card;
}

export default defineControlUiPlugin({
  id: "reef",
  activate(host) {
    if (!host.connection.canAdmin) {
      return;
    }
    const registrations = [
      host.ui.registerPage({ id: "reef", label: "Reef", mount: createReefPage(host) }),
      host.ui.registerNavigation({
        id: "reef",
        label: "Reef",
        page: { id: "reef" },
        icon: "waves",
        order: 35,
      }),
    ];
    return () => registrations.toReversed().forEach((dispose) => dispose());
  },
});
