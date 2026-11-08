import {
  defineControlUiPlugin,
  type ControlUiComponentHandle,
  type ControlUiDialogProps,
  type ControlUiView,
} from "openclaw/plugin-sdk/control-ui";
import type { RelayCaller } from "./caller.js";
import { createTranslator } from "./i18n/index.ts";
import { loadMessages } from "./i18n/locales.ts";
import type { RelayGrant } from "./state.js";
import "./control-ui.css";

type Grants = { grants: RelayGrant[]; caller: RelayCaller; relayUrl: string };
type Consent = {
  kind: "oauth" | "link";
  clientName: string;
  redirectHost: string;
  expiresAt: number;
  caller: RelayCaller;
};
type Pairing = { code: string; expiresAt: number; mcpUrl: string };

const READ_WRITE = new Set(["operator.read", "operator.write"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
}

const mountConnectedApps: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  let context = initialContext;
  let snapshot: Grants | undefined;
  let consent: Consent | undefined;
  let requestId = context.props.request ?? "";
  let fullAccess = false;
  let busy = false;
  let error = "";
  let errorDetail = "";
  let notice = "";
  let generation = 0;
  let available = false;
  let renderedConnection = "";
  let renderedLocale = "";
  let disposed = false;
  let dialog: ControlUiComponentHandle<ControlUiDialogProps> | undefined;
  const page = element("section", undefined, "mcp-connected-apps");
  const overlay = element("div");
  container.append(page, overlay);
  const t = createTranslator(() => host.locale);
  const dateFormat = (locale: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  let dates = dateFormat(host.locale);
  const canUse = () => host.connection.connected && host.connection.canRead;
  const current = (id: number) =>
    !disposed && !context.signal.aborted && context.presented && canUse() && generation === id;
  const caller = () => consent?.caller ?? snapshot?.caller;
  const chosenCeiling = (full = fullAccess) => {
    const scopes = caller()?.ceiling ?? [];
    return full ? [...scopes] : scopes.filter((scope) => READ_WRITE.has(scope));
  };
  const closeDialog = () => {
    dialog?.dispose();
    dialog = undefined;
  };

  function accessLabel(scopes: readonly string[]) {
    if (scopes.includes("operator.admin")) {
      return t("mcpRelay.access.admin");
    }
    if (scopes.some((scope) => !READ_WRITE.has(scope))) {
      return t("mcpRelay.access.fullRole");
    }
    return t(
      scopes.includes("operator.write") ? "mcpRelay.access.readWrite" : "mcpRelay.access.readOnly",
    );
  }

  // No host disclosure exists for plugin pages, so raw details use a native collapsed one.
  function errorAlert(summary: string, detail: string) {
    const node = element("div", summary, "mcp-connected-apps__error");
    node.setAttribute("role", "alert");
    if (detail) {
      const details = element("details");
      details.append(element("summary", t("mcpRelay.errors.showDetails")), element("p", detail));
      node.append(details);
    }
    return node;
  }

  function errorDetailOf(cause: unknown) {
    return cause instanceof Error ? host.redact(cause.message) : "";
  }

  function button(label: string, action: () => void, primary = false) {
    const node = element("button", label, primary ? "btn primary" : "btn");
    node.type = "button";
    node.disabled = busy || !canUse();
    node.addEventListener("click", action);
    return node;
  }

  function accessPicker(
    selectedFull: boolean,
    onChange: (full: boolean) => void,
    groupName = "mcp-relay-consent-access",
  ) {
    const scopes = caller()?.ceiling ?? [];
    const group = element("fieldset", undefined, "mcp-connected-apps__access");
    group.append(element("legend", t("mcpRelay.access.legend")));
    const basic = scopes.filter((scope) => READ_WRITE.has(scope));
    const choices = [
      {
        full: false,
        label: accessLabel(basic),
        detail: t(
          basic.includes("operator.write")
            ? "mcpRelay.access.readWriteDetail"
            : "mcpRelay.access.readOnlyDetail",
        ),
      },
    ];
    if (scopes.some((scope) => !READ_WRITE.has(scope))) {
      choices.push({
        full: true,
        label: t("mcpRelay.access.fullRole"),
        detail: t(
          scopes.includes("operator.admin")
            ? "mcpRelay.access.adminDetail"
            : "mcpRelay.access.fullRoleDetail",
        ),
      });
    }
    for (const choice of choices) {
      const label = element("label", undefined, "mcp-connected-apps__choice");
      const input = element("input");
      input.type = "radio";
      input.name = groupName;
      input.value = choice.full ? "full" : "read-write";
      input.checked = selectedFull === choice.full;
      input.disabled = busy;
      input.addEventListener("change", () => {
        onChange(choice.full);
      });
      const copy = element("span");
      copy.append(element("strong", choice.label), element("small", choice.detail));
      label.append(input, copy);
      group.append(label);
    }
    return group;
  }

  async function run(failure: string, action: (id: number) => Promise<void>) {
    if (busy || !current(generation)) {
      return;
    }
    const id = ++generation;
    busy = true;
    error = "";
    errorDetail = "";
    notice = "";
    if (snapshot) {
      // The existing rows stay valid while the authoritative reply is pending.
      page.querySelector(".mcp-connected-apps__error")?.remove();
      page.querySelector(".mcp-connected-apps__feedback")!.textContent = t(
        "mcpRelay.connectedApps.loading",
      );
      for (const control of page.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        "button, input",
      )) {
        control.disabled = true;
      }
    } else {
      render();
    }
    try {
      await action(id);
    } catch (cause) {
      if (current(id)) {
        error = failure;
        errorDetail = errorDetailOf(cause);
      }
    } finally {
      if (current(id)) {
        busy = false;
        render();
      }
    }
  }

  function refresh() {
    closeDialog();
    return run(t("mcpRelay.errors.load"), async (id) => {
      const grants = await host.request<Grants>("mcp-relay.grants", {});
      if (!current(id)) {
        return;
      }
      snapshot = grants;
      consent = undefined;
      if (requestId) {
        const description = await host.request<Consent>("mcp-relay.authorize.describe", {
          requestId,
        });
        if (current(id)) {
          consent = description;
        }
      }
    });
  }

  function showPairing(returnFocusTarget: HTMLElement, pairingCaller: RelayCaller) {
    if (!current(generation)) {
      return;
    }
    let pairingFull = false;
    const content = element("div", undefined, "mcp-connected-apps mcp-connected-apps__dialog");
    let pairing: Pairing | undefined;
    let pairingBusy = false;
    let pairingError = "";
    let pairingErrorDetail = "";
    const createPairing = async () => {
      if (pairingBusy || !pairingCaller.canPair || !current(generation)) {
        return;
      }
      const id = generation;
      pairingBusy = true;
      pairingError = "";
      pairingErrorDetail = "";
      draw();
      try {
        pairing = await host.request<Pairing>("mcp-relay.pair", {
          ceiling: chosenCeiling(pairingFull),
        });
      } catch (cause) {
        pairingError = t("mcpRelay.errors.pair");
        pairingErrorDetail = errorDetailOf(cause);
      }
      if (current(id) && dialog) {
        pairingBusy = false;
        draw();
      }
    };
    const pairingDescription = () =>
      t("mcpRelay.pairing.description", { principal: pairingCaller.principalLabel });
    const draw = () => {
      content.replaceChildren();
      content.append(
        element("h2", t("mcpRelay.pairing.title")),
        element("p", pairingDescription()),
      );
      if (pairing) {
        content.append(element("p", t("mcpRelay.pairing.enterCode")));
        content.append(element("code", pairing.code, "mcp-connected-apps__code"));
        content.append(
          element("p", t("mcpRelay.pairing.expires", { time: dates.format(pairing.expiresAt) })),
        );
        const url = element("p");
        url.append(
          element("strong", t("mcpRelay.pairing.mcpUrl")),
          " ",
          element("code", pairing.mcpUrl),
        );
        content.append(url);
      } else {
        content.append(
          accessPicker(
            pairingFull,
            (full) => {
              pairingFull = full;
              draw();
            },
            "mcp-relay-pair-access",
          ),
        );
        const create = button(
          t(pairingBusy ? "mcpRelay.pairing.creating" : "mcpRelay.pairing.create"),
          () => void createPairing(),
          true,
        );
        create.disabled = pairingBusy || !chosenCeiling(pairingFull).length;
        content.append(create);
        for (const input of content.querySelectorAll("input")) {
          input.disabled = pairingBusy;
        }
      }
      const dismiss = button(
        t(pairing ? "mcpRelay.pairing.done" : "mcpRelay.pairing.cancel"),
        closeDialog,
      );
      dismiss.disabled = pairingBusy;
      const actions = element("div", undefined, "mcp-connected-apps__actions");
      actions.append(dismiss);
      content.append(actions);
      if (pairingError) {
        content.append(errorAlert(pairingError, pairingErrorDetail));
      }
    };
    draw();
    dialog = host.components.mountDialog(overlay, {
      label: t("mcpRelay.pairing.title"),
      description: pairingDescription(),
      content,
      returnFocusTarget,
      onCancel: () => {
        if (pairingBusy) {
          return false;
        }
        closeDialog();
        return true;
      },
    });
  }

  function decide(allow: boolean) {
    const approvedRequest = requestId;
    const relayUrl = snapshot?.relayUrl;
    if (!consent || !relayUrl) {
      return;
    }
    const ceiling = chosenCeiling();
    const app = { app: consent.clientName };
    void run(t(allow ? "mcpRelay.errors.approve" : "mcpRelay.errors.deny", app), async (id) => {
      const result = await host.request<{ continueUrl: string }>(
        allow ? "mcp-relay.authorize.approve" : "mcp-relay.authorize.deny",
        { requestId: approvedRequest, ...(allow ? { ceiling } : {}) },
      );
      if (!current(id)) {
        return;
      }
      const url = new URL(result.continueUrl);
      if (
        url.origin !== new URL(relayUrl).origin ||
        url.pathname !== "/oauth/continue" ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("request") !== approvedRequest
      ) {
        throw new Error(t("mcpRelay.errors.invalidReturn"));
      }
      window.location.assign(url.href);
    });
  }

  function render() {
    const header = element("header", undefined, "mcp-connected-apps__header");
    const heading = element("div");
    heading.append(
      element("h1", t("mcpRelay.connectedApps.title")),
      element("p", t("mcpRelay.connectedApps.subtitle")),
    );
    header.append(
      heading,
      button(t("mcpRelay.connectedApps.refresh"), () => void refresh()),
    );
    page.replaceChildren(header);
    if (!canUse()) {
      page.append(
        element(
          "p",
          t(
            host.connection.connected
              ? "mcpRelay.connectedApps.readRequired"
              : "mcpRelay.connectedApps.connectGateway",
          ),
        ),
      );
      return;
    }
    if (error) {
      page.append(errorAlert(error, errorDetail));
    }
    const feedback = element(
      "p",
      busy ? t("mcpRelay.connectedApps.loading") : notice,
      "mcp-connected-apps__feedback",
    );
    feedback.setAttribute("role", "status");
    page.append(feedback);
    if (!snapshot) {
      return;
    }
    const connectedCaller = snapshot.caller;
    if (requestId && consent) {
      const panel = element("section", undefined, "mcp-connected-apps__consent");
      const details = element("dl", undefined, "mcp-connected-apps__details");
      for (const [term, value] of [
        ["mcpRelay.consent.approvingAs", consent.caller.principalLabel],
        ["mcpRelay.consent.returnsTo", consent.redirectHost],
        ["mcpRelay.consent.expires", dates.format(consent.expiresAt)],
      ] as const) {
        const item = element("div");
        item.append(element("dt", t(term)), element("dd", value));
        details.append(item);
      }
      panel.append(
        element(
          "span",
          t(
            consent.kind === "link"
              ? "mcpRelay.consent.connectGateway"
              : "mcpRelay.consent.connectionRequest",
          ),
          "mcp-connected-apps__eyebrow",
        ),
        element("h2", t("mcpRelay.consent.title", { app: consent.clientName })),
        details,
        accessPicker(fullAccess, (full) => {
          fullAccess = full;
        }),
        element("p", t("mcpRelay.consent.hint"), "mcp-connected-apps__hint"),
      );
      const actions = element("div", undefined, "mcp-connected-apps__actions");
      const allow = button(t("mcpRelay.consent.allow"), () => decide(true), true);
      allow.disabled = busy || !consent.caller.canPair || !chosenCeiling().length;
      actions.append(
        button(t("mcpRelay.consent.deny"), () => decide(false)),
        allow,
      );
      panel.append(actions);
      if (!consent.caller.canPair) {
        panel.append(element("p", t("mcpRelay.consent.notAllowed"), "mcp-connected-apps__hint"));
      }
      page.append(panel);
    }
    const toolbar = element("div", undefined, "mcp-connected-apps__toolbar");
    toolbar.append(
      element(
        "p",
        connectedCaller.canAdmin
          ? t("mcpRelay.connectedApps.allApps")
          : t("mcpRelay.connectedApps.appsConnectedAs", {
              principal: connectedCaller.principalLabel,
            }),
      ),
    );
    if (connectedCaller.canPair) {
      const pair = button(
        t("mcpRelay.pairing.title"),
        () => showPairing(pair, connectedCaller),
        true,
      );
      toolbar.append(pair);
    }
    const list = element("div", undefined, "mcp-connected-apps__list");
    page.append(
      toolbar,
      list,
      element("p", t("mcpRelay.connectedApps.revokeHint"), "mcp-connected-apps__hint"),
    );
    if (!snapshot.grants.length) {
      list.append(
        element("h2", t("mcpRelay.connectedApps.emptyTitle")),
        element("p", t("mcpRelay.connectedApps.emptyBody")),
      );
    }
    for (const grant of snapshot.grants) {
      const row = element("article", undefined, "mcp-connected-apps__grant");
      const own =
        grant.principal.kind === connectedCaller.principal.kind &&
        (grant.principal.kind === "owner" ||
          (connectedCaller.principal.kind === "person" &&
            grant.principal.profileId === connectedCaller.principal.profileId));
      const principalLabel =
        grant.principal.kind === "owner"
          ? t("mcpRelay.connectedApps.gatewayOwner")
          : (grant.principalLabel ??
            (own ? connectedCaller.principalLabel : t("mcpRelay.connectedApps.anotherPerson")));
      const summary = element("div");
      summary.append(
        element("h2", grant.clientName),
        element(
          "p",
          t("mcpRelay.connectedApps.grantSummary", {
            principal: principalLabel,
            access: accessLabel(grant.ceiling),
          }),
          "mcp-connected-apps__hint",
        ),
        element(
          "small",
          grant.lastUsedAt !== undefined
            ? t("mcpRelay.connectedApps.lastUsed", { time: dates.format(grant.lastUsedAt) })
            : t("mcpRelay.connectedApps.notUsedYet", { time: dates.format(grant.createdAt) }),
        ),
      );
      row.append(summary);
      if ((own || connectedCaller.canAdmin) && host.connection.canWrite) {
        const app = { app: grant.clientName };
        row.append(
          button(t("mcpRelay.connectedApps.revoke"), () => {
            void run(t("mcpRelay.errors.revoke", app), async (id) => {
              await host.request("mcp-relay.revoke", { grantId: grant.grantId });
              const result = await host.request<Grants>("mcp-relay.grants", {});
              if (current(id)) {
                snapshot = result;
                notice = t("mcpRelay.connectedApps.revoked", app);
              }
            });
          }),
        );
      }
      list.append(row);
    }
  }

  function sync() {
    const connection = host.connection;
    const connectionKey = `${connection.connected}:${connection.canRead}:${connection.canWrite}`;
    // Session and agent publications do not change this page or its focused controls.
    let needsRender = connectionKey !== renderedConnection;
    renderedConnection = connectionKey;
    const locale = host.locale;
    if (locale !== renderedLocale) {
      needsRender = true;
      renderedLocale = locale;
      dates = dateFormat(locale);
      // English renders now; the translated catalog re-renders the page when it settles.
      void loadMessages(locale)?.then(() => {
        if (!disposed && host.locale === locale) {
          render();
        }
      });
    }
    const nextRequest = context.props.request ?? "";
    const next = canUse() && context.presented && !context.signal.aborted;
    if (next !== available || nextRequest !== requestId) {
      needsRender = true;
      available = next;
      requestId = nextRequest;
      generation += 1;
      busy = false;
      snapshot = undefined;
      consent = undefined;
      fullAccess = false;
      error = "";
      notice = "";
      closeDialog();
      if (next) {
        void refresh();
        return;
      }
    }
    if (needsRender) {
      render();
    }
  }
  const unsubscribe = host.subscribe(sync);
  sync();
  return {
    update(next) {
      context = next;
      sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      snapshot = undefined;
      consent = undefined;
      closeDialog();
      unsubscribe();
      // A retained focus event can keep the page alive after it is detached.
      page.replaceChildren();
      overlay.replaceChildren();
      page.remove();
      overlay.remove();
    },
  };
};

export default defineControlUiPlugin({
  id: "mcp-relay",
  activate(host) {
    const t = createTranslator(() => host.locale);
    return host.ui.registerPage({
      id: "connected-apps",
      label: t("mcpRelay.connectedApps.title"),
      mount: mountConnectedApps,
    });
  },
});
